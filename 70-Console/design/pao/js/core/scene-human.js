/**
 * scene-human.js —— Personal AI OS · 程序化全息数字人（胸像）
 * 依赖：THREE r128（全局 THREE）、PAO 命名空间
 * 风格：ES5（var / function）+ IIFE；不引用 PAO.scene / PAO.engine，可独立复用
 * 造型层级（group 原点在脚下，总高约 1.66）：底座双环 → 胸腔圆柱 → 颈 → 略扁球头
 *   → 面部网格壳 → 眼睛 ×2 → 嘴部声波条 ×4（InstancedMesh）→ 上升粒子 → 外围轨道环
 * 材质：单一自制 ShaderMaterial 共享给胸/颈/头，三种核心效果：
 *   1) fresnel 边缘光  pow(1 - |dot(N, V)|, 2.2)
 *   2) 横向扫描带    sin(vWorldPos.y * 16 - uTime * uScanSpeed)
 *   3) 底部渐隐      smoothstep(0, 0.35, vWorldPos.y)
 * 性能约定：每帧零对象分配（所有矩阵/临时对象预分配复用）；draw call ≤ 14
 */
(function (global) {
  'use strict';

  var PAO = global.PAO = global.PAO || {};

  /* ===== 一、常量与状态表 ===== */

  var TWO_PI = Math.PI * 2;
  var CYAN = 0x55DDF5;        // 主题全息青
  var CYAN_SOFT = 0x2AA8C8;   // 内核体积色
  var CYAN_LIGHT = 0xC8FBFF;  // 眼睛 / 声波条高光色

  // 状态表：idx 供 shader 的 uState 做亮度微调（0..5）
  var STATE_TABLE = {
    idle:      { idx: 0, opacity: 0.55, scan: 2.0, eye: 0.55, tilt:  0.00, ring: 1.00, part: 1.00, breathAmp: 0.012, breathSpd: 1.60 },
    listening: { idx: 1, opacity: 0.65, scan: 2.6, eye: 0.95, tilt:  0.05, ring: 1.80, part: 1.00, breathAmp: 0.010, breathSpd: 2.10 },
    thinking:  { idx: 2, opacity: 0.60, scan: 3.4, eye: 0.70, tilt: -0.06, ring: 1.35, part: 0.80, breathAmp: 0.008, breathSpd: 1.90 },
    speaking:  { idx: 3, opacity: 0.75, scan: 2.8, eye: 1.00, tilt:  0.00, ring: 1.20, part: 1.20, breathAmp: 0.014, breathSpd: 3.20 },
    working:   { idx: 4, opacity: 0.85, scan: 4.2, eye: 0.85, tilt:  0.00, ring: 2.60, part: 2.50, breathAmp: 0.016, breathSpd: 2.60 },
    waiting:   { idx: 5, opacity: 0.32, scan: 1.2, eye: 0.40, tilt:  0.00, ring: 0.60, part: 0.60, breathAmp: 0.020, breathSpd: 0.55 }
  };

  /* ===== 二、全息 shader（用数组 join，保持 ES5 无模板字符串） ===== */

  var VERT_SRC = [
    'uniform float uTime;',
    'uniform float uScanSpeed;',
    'varying vec3 vWorldPos;',   // 世界坐标：扫描带 + 底部渐隐都基于它，整体一致
    'varying vec3 vNormalV;',    // 视空间法线
    'varying vec3 vViewDir;',    // 视空间视线方向
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  vec4 mv = viewMatrix * wp;',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    'uniform float uTime;',
    'uniform float uOpacity;',
    'uniform float uScanSpeed;',
    'uniform float uState;',
    'uniform vec3  uColor;',
    'varying vec3 vWorldPos;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'void main() {',
    '  vec3 N = normalize(vNormalV);',
    '  vec3 V = normalize(vViewDir);',
    // —— 效果 1：fresnel 边缘光，掠射角更亮，做出玻璃壳质感
    '  float fres = pow(1.0 - abs(dot(N, V)), 2.2);',
    // —— 效果 2：横向扫描带（自下而上流动，smoothstep 柔化边缘）
    '  float raw  = sin(vWorldPos.y * 16.0 - uTime * uScanSpeed);',
    '  float band = smoothstep(0.72, 1.0, raw * 0.5 + 0.5);',
    // —— 效果 3：底部渐隐，下缘淡出，去掉硬切边
    '  float fade = smoothstep(0.0, 0.35, vWorldPos.y);',
    // 竖向细条纹，补一层“投影幕”质感
    '  float stripe = 0.5 + 0.5 * sin(vWorldPos.x * 90.0 + uTime * 1.5);',
    // 状态亮度微调（0..5 → 0.92..1.095）
    '  float gain = 0.92 + uState * 0.035;',
    '  float a = (0.14 + fres * 1.25 + band * 0.85 + stripe * 0.05) * fade * gain * uOpacity;',
    '  a = clamp(a, 0.0, 1.0);',
    '  vec3 col = uColor * (0.55 + fres * 0.85 + band * 0.85);',
    '  col += vec3(0.05, 0.12, 0.16) * band;',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  /* ===== 三、工厂函数 ===== */

  PAO.buildHuman = function (opts) {
    opts = opts || {};
    var scale = (typeof opts.scale === 'number') ? opts.scale : 1;
    var detailed = (opts.detailed !== false);
    var lowQuality = !detailed;
    var group = new THREE.Group();
    group.name = 'PAO_Human';
    group.scale.setScalar(scale);
    // 呼吸缩放只作用于躯干+头，不带动底座环与粒子
    var bust = new THREE.Group();
    bust.name = 'PAO_Human_Bust';
    group.add(bust);
    /* ---------- 3.1 共享全息材质 ---------- */
    var holoMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:      { value: 0 },
        uOpacity:   { value: 0.55 },
        uColor:     { value: new THREE.Color(CYAN) },
        uScanSpeed: { value: 2.0 },
        uState:     { value: 0 }
      },
      vertexShader: VERT_SRC,
      fragmentShader: FRAG_SRC,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    });
    /* ---------- 3.2 胸腔：上宽下窄的圆柱，读起来是胸像不是方块 ---------- */
    var chestGeo = new THREE.CylinderGeometry(0.62, 0.42, 0.85, 24, 1, false);
    var chest = new THREE.Mesh(chestGeo, holoMat);
    chest.position.y = 0.42;
    bust.add(chest);
    /* ---------- 3.3 颈 ---------- */
    var neckGeo = new THREE.CylinderGeometry(0.12, 0.14, 0.18, 16, 1, false);
    var neck = new THREE.Mesh(neckGeo, holoMat);
    neck.position.y = 0.95;
    bust.add(neck);
    /* ---------- 3.4 头部装配：pivot 放在颈根，倾斜（点头）以颈为轴 ---------- */
    var HEAD_PIVOT_Y = 0.98;
    var headPivot = new THREE.Group();
    headPivot.name = 'PAO_Human_HeadPivot';
    headPivot.position.y = HEAD_PIVOT_Y;
    bust.add(headPivot);
    // 头（略扁）
    var headGeo = new THREE.SphereGeometry(0.34, 32, 24);
    var head = new THREE.Mesh(headGeo, holoMat);
    head.position.y = 0.32;          // 世界 y ≈ 1.30
    head.scale.y = 1.06;
    headPivot.add(head);
    // 头部内核对球：低透明 DoubleSide，给一点体积感
    var coreGeo = new THREE.SphereGeometry(0.30, 20, 14);
    var coreMat = new THREE.MeshBasicMaterial({ color: CYAN_SOFT, transparent: true, opacity: 0.06,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    var headCore = new THREE.Mesh(coreGeo, coreMat);
    headCore.position.y = 0.32;
    headCore.scale.y = 1.06;
    headPivot.add(headCore);
    // 面部网格壳：头的 wireframe 复制体
    var faceGeo = new THREE.SphereGeometry(0.345, 14, 10);
    var faceMat = new THREE.MeshBasicMaterial({ color: CYAN, wireframe: true, transparent: true,
      opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending });
    var faceWire = new THREE.Mesh(faceGeo, faceMat);
    faceWire.position.y = 0.32;
    faceWire.scale.y = 1.06;
    headPivot.add(faceWire);
    /* ---------- 3.5 眼睛（两只共享一个材质 → 2 draw call） ---------- */
    var eyeGeo = new THREE.SphereGeometry(0.035, 10, 8);
    var eyeMat = new THREE.MeshBasicMaterial({
      color: CYAN_LIGHT,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.11, 0.36, 0.30);   // 世界 y ≈ 1.34
    headPivot.add(eyeL);
    var eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.11, 0.36, 0.30);
    headPivot.add(eyeR);
    /* ---------- 3.6 嘴部声波条：4 条合并进 1 个 InstancedMesh ---------- */
    var MOUTH_COUNT = 4;
    var mouthGeo = new THREE.BoxGeometry(0.012, 0.05, 0.01);
    var mouthMat = new THREE.MeshBasicMaterial({
      color: CYAN_LIGHT,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var mouth = new THREE.InstancedMesh(mouthGeo, mouthMat, MOUTH_COUNT);
    mouth.name = 'PAO_Human_Mouth';
    mouth.position.set(0, 0.24, 0.31);      // 世界 y ≈ 1.22
    mouth.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 预分配：实例矩阵写入用的临时对象，每帧复用，零分配
    var mouthDummy = new THREE.Object3D();
    var mouthOffsets = new Float32Array(MOUTH_COUNT);
    var i;
    for (i = 0; i < MOUTH_COUNT; i++) {
      mouthOffsets[i] = (i - (MOUTH_COUNT - 1) / 2) * 0.03;   // -0.045 .. 0.045
      mouthDummy.position.set(mouthOffsets[i], 0, 0);
      mouthDummy.scale.set(1, 0.3, 1);
      mouthDummy.updateMatrix();
      mouth.setMatrixAt(i, mouthDummy.matrix);
    }
    mouth.instanceMatrix.needsUpdate = true;
    headPivot.add(mouth);
    /* ---------- 3.7 底座双环 ---------- */
    function makeRing(radius, tube, opacity) {
      var g = new THREE.TorusGeometry(radius, tube, 4, 96);
      var m = new THREE.MeshBasicMaterial({
        color: CYAN,
        transparent: true,
        opacity: opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      var mesh = new THREE.Mesh(g, m);
      return mesh;
    }
    var ringA = makeRing(0.55, 0.006, 0.55);
    ringA.position.y = 0.01;
    ringA.rotation.x = Math.PI / 2;
    group.add(ringA);
    var ringB = makeRing(0.72, 0.004, 0.40);
    ringB.position.y = 0.03;
    ringB.rotation.x = Math.PI / 2;
    group.add(ringB);
    /* ---------- 3.8 外围倾斜轨道环 ---------- */
    var orbit = makeRing(0.95, 0.003, 0.30);
    orbit.position.y = 1.10;
    orbit.rotation.x = 1.42;
    group.add(orbit);
    /* ---------- 3.9 上升粒子（沿 Y 从 0 → 2.0 循环） ---------- */
    var partCount = detailed ? 22 : 14;
    var partGeo = new THREE.BufferGeometry();
    var partPos = new Float32Array(partCount * 3);
    var pAngle = new Float32Array(partCount);
    var pRadius = new Float32Array(partCount);
    var pSpeed = new Float32Array(partCount);
    var pY = new Float32Array(partCount);
    for (i = 0; i < partCount; i++) {
      pAngle[i] = (i / partCount) * TWO_PI + Math.random() * 0.5;
      pRadius[i] = 0.40 + Math.random() * 0.23;   // 0.40 – 0.63
      pSpeed[i] = 0.16 + Math.random() * 0.16;
      pY[i] = Math.random() * 2.0;
      partPos[i * 3] = Math.cos(pAngle[i]) * pRadius[i];
      partPos[i * 3 + 1] = pY[i];
      partPos[i * 3 + 2] = Math.sin(pAngle[i]) * pRadius[i];
    }
    partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
    partGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    var partMat = new THREE.PointsMaterial({
      color: CYAN,
      size: 0.035,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var particles = new THREE.Points(partGeo, partMat);
    particles.name = 'PAO_Human_Particles';
    group.add(particles);
    /* ---------- 3.10 头顶思考点（thinking 时出现的 3 个绕行点） ---------- */
    var thinkCount = 3;
    var thinkGeo = new THREE.BufferGeometry();
    var thinkPos = new Float32Array(thinkCount * 3);
    thinkGeo.setAttribute('position', new THREE.BufferAttribute(thinkPos, 3));
    thinkGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    var thinkMat = new THREE.PointsMaterial({
      color: CYAN_LIGHT,
      size: 0.06,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var thinkPoints = new THREE.Points(thinkGeo, thinkMat);
    thinkPoints.name = 'PAO_Human_ThinkDots';
    thinkPoints.visible = false;
    group.add(thinkPoints);
    /* ============================================================
     * 四、状态机（只改目标值，update 里插值）
     * ============================================================ */
    var st = STATE_TABLE.idle;
    // 当前插值值
    var curOpacity = st.opacity;
    var curScan = st.scan;
    var curEye = st.eye;
    var curTilt = st.tilt;
    var curRing = st.ring;
    var curPart = st.part;
    var curIdx = st.idx;
    var curBreathAmp = st.breathAmp;
    var curBreathSpd = st.breathSpd;
    // 目标值
    var tgtOpacity = st.opacity;
    var tgtScan = st.scan;
    var tgtEye = st.eye;
    var tgtTilt = st.tilt;
    var tgtRing = st.ring;
    var tgtPart = st.part;
    var tgtIdx = st.idx;
    var tgtBreathAmp = st.breathAmp;
    var tgtBreathSpd = st.breathSpd;
    var targetName = 'idle';
    var mouthMix = 0;      // 张嘴动画权重
    var thinkMix = 0;      // 思考点显隐权重
    var envOpacity = 1;    // setOpacity 全局包络
    var curTime = 0;
    var disposed = false;
    var speakTimer = null;
    function applyState(name) {
      var s = STATE_TABLE[name] || STATE_TABLE.idle;
      targetName = STATE_TABLE[name] ? name : 'idle';
      tgtOpacity = s.opacity;
      tgtScan = s.scan;
      tgtEye = s.eye;
      tgtTilt = s.tilt;
      tgtRing = s.ring;
      tgtPart = s.part;
      tgtIdx = s.idx;
      tgtBreathAmp = s.breathAmp;
      tgtBreathSpd = s.breathSpd;
    }
    /* ============================================================
     * 五、对外 API
     * ============================================================ */
    function setState(s) {
      if (disposed) return;
      applyState(s);
      if (s === 'speaking') return;   // speaking 的时长由 speak() 管理
      if (speakTimer !== null) {      // 手动切走状态时取消未结束的 speak 计时
        clearTimeout(speakTimer);
        speakTimer = null;
      }
    }
    function speak(text, done) {
      if (disposed) return;
      var len = text ? String(text).length : 0;
      var dur = Math.min(6000, len * 60);
      applyState('speaking');
      if (speakTimer !== null) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      speakTimer = setTimeout(function () {
        speakTimer = null;
        if (disposed) return;
        applyState('idle');
        if (typeof done === 'function') done();
      }, dur);
    }
    function setOpacity(v) {
      if (disposed) return;
      if (typeof v !== 'number' || !isFinite(v)) v = 1;
      envOpacity = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    function setVisible(v) {
      group.visible = !!v;
    }
    function setQuality(q) {
      if (disposed) return;
      lowQuality = (q === 'low');
      faceWire.visible = !lowQuality;
      orbit.visible = !lowQuality;
      thinkPoints.visible = thinkMix > 0.02 && !lowQuality;
      if (lowQuality) {
        partGeo.setDrawRange(0, Math.max(2, Math.floor(partCount / 2)));
      } else {
        partGeo.setDrawRange(0, partCount);
      }
    }
    /* ============================================================
     * 六、每帧更新（零对象分配）
     * ============================================================ */
    function update(dt, t) {
      if (disposed) return;
      if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) dt = 1 / 60;
      if (dt > 0.1) dt = 0.1;                       // 掉帧保护
      curTime += dt;
      if (typeof t === 'number' && isFinite(t)) curTime = t;

      // 帧率无关的 0.08 插值系数：60fps 时严格等于 0.08
      var k = 0.08 * dt * 60;
      if (k > 1) k = 1;
      curOpacity += (tgtOpacity - curOpacity) * k;
      curScan += (tgtScan - curScan) * k;
      curEye += (tgtEye - curEye) * k;
      curTilt += (tgtTilt - curTilt) * k;
      curRing += (tgtRing - curRing) * k;
      curPart += (tgtPart - curPart) * k;
      curIdx += (tgtIdx - curIdx) * k;
      curBreathAmp += (tgtBreathAmp - curBreathAmp) * k;
      curBreathSpd += (tgtBreathSpd - curBreathSpd) * k;
      var speakTarget = (targetName === 'speaking') ? 1 : 0;
      mouthMix += (speakTarget - mouthMix) * k;
      var thinkTarget = (targetName === 'thinking') ? 1 : 0;
      thinkMix += (thinkTarget - thinkMix) * k;
      var vis = group.visible;
      if (!vis) return;   // 不可见时不跑几何动画，省 CPU
      /* --- 6.1 全息 shader uniforms --- */
      var u = holoMat.uniforms;
      u.uTime.value = curTime;
      u.uScanSpeed.value = curScan;
      u.uState.value = curIdx;
      u.uOpacity.value = curOpacity * envOpacity;
      /* --- 6.2 呼吸缩放（idle 微幅，waiting 缓慢大幅） --- */
      var breath = 1 + curBreathAmp * Math.sin(curTime * curBreathSpd);
      bust.scale.setScalar(breath);
      /* --- 6.3 头部倾角 --- */
      headPivot.rotation.x = curTilt;
      /* --- 6.4 眼睛亮度 --- */
      eyeMat.opacity = Math.min(1, curEye * 0.9 * envOpacity);
      /* --- 6.5 嘴部声波条（speaking 时 sin(t*9 + i*1.3)） --- */
      var mOpacity = (0.45 + 0.55 * mouthMix) * envOpacity;
      mouthMat.opacity = mOpacity < 0 ? 0 : (mOpacity > 1 ? 1 : mOpacity);
      for (i = 0; i < MOUTH_COUNT; i++) {
        var base = 0.28 + 0.10 * Math.sin(curTime * 1.6 + i * 0.9);
        var wave = 0.5 + 0.5 * Math.sin(curTime * 9 + i * 1.3);
        var sy = base + mouthMix * (0.30 + 0.95 * wave);
        if (sy < 0.06) sy = 0.06;
        mouthDummy.position.set(mouthOffsets[i], 0, 0);
        mouthDummy.scale.set(1, sy, 1);
        mouthDummy.updateMatrix();
        mouth.setMatrixAt(i, mouthDummy.matrix);
      }
      mouth.instanceMatrix.needsUpdate = true;
      /* --- 6.6 底座环：反向自转 + 轻微进动（纯对称环自转不可见，补一点摆动） --- */
      ringA.rotation.z += dt * 0.70 * curRing;
      ringB.rotation.z -= dt * 0.50 * curRing;
      ringA.rotation.x = Math.PI / 2 + Math.sin(curTime * 0.55) * 0.05;
      ringB.rotation.x = Math.PI / 2 - Math.sin(curTime * 0.45) * 0.05;
      ringA.material.opacity = 0.55 * (0.55 + 0.45 * Math.min(1, curRing * 0.6)) * envOpacity;
      ringB.material.opacity = 0.40 * (0.55 + 0.45 * Math.min(1, curRing * 0.6)) * envOpacity;
      /* --- 6.7 外围轨道环 --- */
      orbit.rotation.z += dt * 0.22 * curRing;
      orbit.rotation.y = Math.sin(curTime * 0.35) * 0.25;
      /* --- 6.8 上升粒子 --- */
      var posArr = partPos;
      for (i = 0; i < partCount; i++) {
        pY[i] += pSpeed[i] * dt * curPart;
        if (pY[i] > 2.0) pY[i] -= 2.0;
        var a = pAngle[i] + curTime * 0.18;
        posArr[i * 3] = Math.cos(a) * pRadius[i];
        posArr[i * 3 + 1] = pY[i];
        posArr[i * 3 + 2] = Math.sin(a) * pRadius[i];
      }
      partGeo.attributes.position.needsUpdate = true;
      partMat.opacity = 0.35 * envOpacity * (0.75 + 0.25 * Math.min(1, curPart * 0.6));
      /* --- 6.9 头顶思考点 --- */
      var showThink = (thinkMix > 0.02) && !lowQuality;
      thinkPoints.visible = showThink;
      if (showThink) {
        for (i = 0; i < thinkCount; i++) {
          var ta = curTime * 1.6 + i * (TWO_PI / 3);
          var tr = 0.42 * (0.88 + 0.12 * Math.sin(curTime * 1.1 + i));
          thinkPos[i * 3] = Math.cos(ta) * tr;
          thinkPos[i * 3 + 1] = 1.62 + Math.sin(curTime * 2.2 + i * 2.0) * 0.06;
          thinkPos[i * 3 + 2] = Math.sin(ta) * tr;
        }
        thinkGeo.attributes.position.needsUpdate = true;
        thinkMat.opacity = thinkMix * 0.95 * envOpacity;
      }
      /* --- 6.10 辅助层透明度包络 --- */
      coreMat.opacity = 0.06 * envOpacity;
      faceMat.opacity = 0.08 * envOpacity;
    }
    /* ============================================================
     * 七、销毁
     * ============================================================ */
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (speakTimer !== null) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      var geos = [];
      var mats = [];
      group.traverse(function (o) {
        if (o.geometry && geos.indexOf(o.geometry) < 0) geos.push(o.geometry);
        var m = o.material;
        if (m) {
          if (mats.indexOf(m) < 0) mats.push(m);
          if (m.uniforms) {                 // ShaderMaterial：清掉纹理引用即可
            m.uniforms = {};
          }
        }
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      var n;
      for (n = 0; n < geos.length; n++) { if (geos[n].dispose) geos[n].dispose(); }
      for (n = 0; n < mats.length; n++) { if (mats[n].dispose) mats[n].dispose(); }
      geos.length = 0;
      mats.length = 0;
      if (group.parent) group.parent.remove(group);
    }
    /* ---------- 初始状态 ---------- */
    applyState('idle');
    setQuality(detailed ? 'high' : 'low');

    return {
      group: group,
      setState: setState,
      speak: speak,
      setOpacity: setOpacity,
      update: update,
      setVisible: setVisible,
      setQuality: setQuality,
      dispose: dispose
    };
  };
})(typeof window !== 'undefined' ? window : this);
