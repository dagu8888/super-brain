/**
 * scene-agents.js —— Personal AI OS 三维界面 · Agent 节点网络层
 * 依赖：THREE r128（全局）、PAO 命名空间；ES5（var/function）+ IIFE
 * 布局：agent_concierge 在中央核心正上方，其余 9 节点成环，各连一条极细曲线到枢纽
 * 性能：每帧零对象分配（临时 Vector3 / Color 全部预分配复用）
 */
(function (global) {
  'use strict';
  var PAO = global.PAO = global.PAO || {};

  // ---------- 状态色（严格按设计稿，不得改动） ----------
  var COLORS = {
    idle: 0x7E8999, thinking: 0x55DDF5, running: 0x91DFFF, waiting: 0xE0B15C,
    completed: 0x5FD6A8, failed: 0xE06767, paused: 0x9178FF
  };

  // 状态视觉映射表：gb 光点基础透明度 / ga 振幅 / gf 频率（opacity = gb + sin(t*gf)*ga）
  // spin 环转速、scale 节点缩放、jit 位置抖动、edge 边线透明度、link 连线透明度
  var STYLE = {
    idle:      { gb: 0.28, ga: 0.035, gf: 1.35, spin: 0.15, scale: 1.00, jit: 0,    edge: 0.30, link: 0.06 },
    thinking:  { gb: 0.90, ga: 0.30,  gf: 11,   spin: 0.60, scale: 1.06, jit: 0.01, edge: 0.30, link: 0.06 },
    running:   { gb: 1.00, ga: 0,     gf: 0,    spin: 1.10, scale: 1.12, jit: 0,    edge: 0.34, link: 0.22 },
    waiting:   { gb: 0.55, ga: 0.25,  gf: 2.4,  spin: 0.25, scale: 1.02, jit: 0,    edge: 0.30, link: 0.06 },
    completed: { gb: 1.00, ga: 0,     gf: 0,    spin: 0.80, scale: 1.10, jit: 0,    edge: 0.40, link: 0.06 },
    failed:    { gb: 1.00, ga: 0,     gf: 0,    spin: 0.50, scale: 1.05, jit: 0,    edge: 0.62, link: 0.06 },
    paused:    { gb: 0.30, ga: 0,     gf: 0,    spin: 0.05, scale: 0.96, jit: 0,    edge: 0.18, link: 0.04 }
  };

  // ---------- 布局常量 ----------
  var HUB_ID = 'trae-chief';                 // 幕僚长（顶层）
  var HUB_Y = 3.4, HUB_R = 0.62, HUB_RING_A = 1.75, HUB_RING_B = 2.35;
  var RING_R = 10.2, RING_N = 9, NODE_R = 0.34, NODE_RING_R = 0.95, PICK_R = 1.0;
  var WORKER_R = 6.8;                        // 执行层：下层两翼
  var REVERT = 2.4, SLOTS = 8, MAX_P = 24 * SLOTS;
  var HOVER_SCALE = 1.25, HOVER_EDGE = 0.7;

  // ---------- 三层节点：幕僚长 → 指挥入口 → 执行者（真实数据来自 PAO.SB） ----------
  function buildDefs() {
    if (!PAO.SB || !PAO.SB.data || !PAO.SB.data.agents.length) return [];
    var model = PAO.SB.agentModel();
    var hub = null, chiefs = [], workers = [];
    for (var i = 0; i < model.length; i++) {
      var m = model[i], def = {
        agentId: m.id, name: m.name, zh: m.zh, role: m.role,
        kind: m.kind, live: m.live, status: m.status, pending: m.pending
      };
      if (m.id === HUB_ID) hub = def;
      else if (m.kind === 'chief') chiefs.push(def);
      else workers.push(def);
    }
    if (!hub) {
      /* 幕僚长不在线时，仍保留一个占位核心（不与入口重复计数） */
      hub = { agentId: HUB_ID, name: 'TRAE', zh: 'TRAE', role: '幕僚长入口', kind: 'chief', live: 'offline', status: 'paused', pending: 0, placeholder: true };
    }
    return [hub].concat(chiefs, workers);
  }

  function hubDef() {
    var defs = buildDefs();
    for (var i = 0; i < defs.length; i++) { if (defs[i].agentId === HUB_ID) return defs[i]; }
    return null;
  }

  // ---------- 预分配复用对象（每帧零 GC） ----------
  var _v1 = new THREE.Vector3();
  var _c1 = new THREE.Color();

  /** 状态光点贴图：canvas 径向渐变，全局共享一张 */
  function glowTexture() {
    var s = 128, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.08)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ============================================================
   * PAO.buildAgents —— 主构建
   * ============================================================ */
  PAO.buildAgents = function () {
    var group = new THREE.Group();
    group.name = 'agentNetwork';

    var pickables = [];   // 可拾取命中球
    var nodes = [];       // 全部节点
    var nodeMap = {};     // agentId -> node
    var hoverId = null;
    var quality = 'high';
    var progress = 1;     // 启动渐显 0..1；默认已就位，宿主可 setProgress(0) 重播
    var elapsed = 0;      // 内部时钟（秒）

    var glowTex = glowTexture();
    var geoCache = {};    // 共享几何体缓存
    function geo(key, factory) {
      if (!geoCache[key]) { geoCache[key] = factory(); }
      return geoCache[key];
    }

    /* ---------------- 4.1 单个 Agent 节点 ---------------- */
    function mkNode(opts, isHub) {
      var id = opts.agentId;
      var g = new THREE.Group();
      g.name = 'agent:' + id;

      var r = isHub ? HUB_R : NODE_R;
      var ringR = isHub ? HUB_RING_A : NODE_RING_R;
      /* 真实数据不套用五行色：幕僚长与入口用青，执行者用紫 */
      var brandColor = (isHub || opts.kind === 'chief') ? 0x55DDF5 : 0x9178FF;

      // 1) 主体多面体
      var pGeo = geo('poly' + (isHub ? 'H' : 'N'), function () {
        return new THREE.IcosahedronGeometry(r, isHub ? 1 : 0);
      });
      var pMat = new THREE.MeshStandardMaterial({
        color: 0x0b1824,
        emissive: new THREE.Color(brandColor).multiplyScalar(0.20),
        metalness: 0.8, roughness: 0.32, transparent: true, opacity: 0.55
      });
      var poly = new THREE.Mesh(pGeo, pMat);
      g.add(poly);

      // 2) 边线（EdgesGeometry + additive，scale 1.28 做出双层轮廓）
      var eGeo = new THREE.EdgesGeometry(pGeo, 15);
      var eMat = new THREE.LineBasicMaterial({
        color: brandColor, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var wire = new THREE.LineSegments(eGeo, eMat);
      wire.scale.setScalar(1.28);
      g.add(wire);

      // 3) 状态光点（Sprite，颜色随状态变）
      var sMat = new THREE.SpriteMaterial({
        map: glowTex, color: COLORS.idle, transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var glow = new THREE.Sprite(sMat);
      var glowBase = isHub ? 1.6 : 0.46;
      glow.scale.setScalar(glowBase);
      g.add(glow);

      // 4) 状态环（TorusGeometry，缓慢自转）
      var rGeo = geo('ring' + (isHub ? 'H' : 'N'), function () {
        return new THREE.TorusGeometry(ringR, isHub ? 0.014 : 0.008, 8, isHub ? 96 : 48);
      });
      var rMat = new THREE.MeshBasicMaterial({
        color: brandColor, transparent: true, opacity: 0.72,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var ring = new THREE.Mesh(rGeo, rMat);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);

      // 枢纽第二层外环 r=1.8
      var ring2 = null, r2Mat = null;
      if (isHub) {
        r2Mat = new THREE.MeshBasicMaterial({
          color: COLORS.idle, transparent: true, opacity: 0.34,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        ring2 = new THREE.Mesh(new THREE.TorusGeometry(HUB_RING_B, 0.008, 8, 96), r2Mat);
        ring2.rotation.x = Math.PI / 2 + 0.42;
        g.add(ring2);
      }

      // 5) 命中球（不可见，供 PAO.scene.handlePick 分发）
      var hit = new THREE.Mesh(
        geo('hit', function () { return new THREE.SphereGeometry(PICK_R, 8, 6); }),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hit.userData.pickKind = 'agent';
      hit.userData.pickId = id;
      g.add(hit);
      pickables.push(hit);

      g.scale.setScalar(0.0001); // 渐显前不可见

      return {
        agentId: id, name: opts.name || id, zh: opts.zh || opts.name || id, isHub: !!isHub,
        kind: opts.kind || (isHub ? 'chief' : 'worker'), role: opts.role || '',
        pending: opts.pending || 0, placeholder: !!opts.placeholder,
        group: g, poly: poly, pMat: pMat, wire: wire, eMat: eMat,
        glow: glow, sMat: sMat, glowBase: glowBase,
        ring: ring, rMat: rMat, ring2: ring2, r2Mat: r2Mat, hit: hit,
        curve: null, _vStart: 0, _vCount: 0,
        status: 'idle', note: '',
        _revertAt: 0, _spin: 0.15, _angle: Math.random() * 6.283, _edge: 0, _link: 0,
        _glow: 0, _scale: 0.0001,
        _col: new THREE.Color(COLORS.idle), _colT: new THREE.Color(COLORS.idle),
        _emi: new THREE.Color(COLORS.idle).multiplyScalar(0.12),
        _emiT: new THREE.Color(COLORS.idle).multiplyScalar(0.12),
        /* 五行身份色：节点"是什么"由色相表达，"正在做什么"由光点表达 */
        _elem: new THREE.Color(brandColor),
        _spawnAt: 0, _slot: -1
      };
    }

    /* ---------------- 4.2 三层布局：幕僚长居顶，入口一排，执行者一排（面向镜头） ---------------- */
    function place(node, i) {
      if (node.isHub) {
        node.group.position.set(0, HUB_Y, 0);
        node._spawnAt = 0;
        return;
      }
      if (node.kind === 'chief') {
        node.group.position.set((i - 2.5) * 3.4, 0.8, (i % 2 ? 0.7 : -0.7));
        node._angle = (i - 2.5) * 0.2;
        node._spawnAt = 0.4 + (i + 1) * 0.05;
        return;
      }
      node.group.position.set((i - 3) * 2.5, -3.2, (i % 2 ? 0.7 : -0.7));
      node._angle = (i - 3) * 0.2;
      node._spawnAt = 0.62 + (i + 1) * 0.035;
    }

    var i, node, defs = buildDefs();
    var chiefI = 0, workerI = 0;
    for (i = 0; i < defs.length; i++) {
      var isHub = defs[i].agentId === HUB_ID;
      node = mkNode(defs[i], isHub);
      node.status = defs[i].status || 'idle';
      nodes.push(node);
      nodeMap[node.agentId] = node;
      group.add(node.group);
    }
    var hub = nodeMap[HUB_ID] || { group: { position: new THREE.Vector3(0, HUB_Y, 0) } };
    for (i = 0; i < nodes.length; i++) {
      place(nodes[i], nodes[i].isHub ? -1 : (nodes[i].kind === 'chief' ? chiefI++ : workerI++));
    }

    /* ---------------- 4.3 连线：全部 tube 合并为 1 个网格 ----------------
     * 9 条 QuadraticBezierCurve3 + TubeGeometry(curve,24,0.006,3) 手动合并成
     * 单一 BufferGeometry，用顶点色承载「每条线自己的状态色 × 连线强度」。
     * additive 混合下 颜色×强度 与 材质 opacity 等效，但只占 1 个 draw call。
     * ------------------------------------------------------------------ */
    var edgeMesh = null, edgeGeo = null, edgeColors = null, edgeMat = null;

    function buildEdges() {
      if (edgeMesh) { group.remove(edgeMesh); edgeGeo.dispose(); edgeMesh = null; }
      var pos = [], nor = [], idx = [], vOff = 0, j, k;
      for (j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.isHub) { n.curve = null; n._vStart = 0; n._vCount = 0; continue; }
        var from = n.group.position, to = hub.group.position;
        // 中间控制点抬高 1.2，形成柔和拱形
        n.curve = new THREE.QuadraticBezierCurve3(
          from.clone(),
          new THREE.Vector3((from.x + to.x) * 0.5, (from.y + to.y) * 0.5 + 1.2, (from.z + to.z) * 0.5),
          to.clone()
        );
        var tg = new THREE.TubeGeometry(n.curve, 24, 0.006, 3, false);
        var pArr = tg.attributes.position.array, nArr = tg.attributes.normal.array, iArr = tg.index.array;
        n._vStart = vOff;
        n._vCount = tg.attributes.position.count;
        for (k = 0; k < pArr.length; k++) { pos.push(pArr[k]); nor.push(nArr[k]); }
        for (k = 0; k < iArr.length; k++) { idx.push(iArr[k] + vOff); }
        vOff += n._vCount;
        tg.dispose();
      }
      edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      edgeGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
      edgeGeo.setIndex(idx);
      edgeColors = new Float32Array(pos.length); // 初始全 0 = 不可见
      edgeGeo.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
      edgeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
      edgeMesh.frustumCulled = false;
      edgeMesh.visible = quality !== 'low';
      group.add(edgeMesh);
    }
    buildEdges();

    /* ---------------- 4.4 流动粒子：全局单一 Points ---------------- */
    var pGeo = new THREE.BufferGeometry();
    var pPos = new Float32Array(MAX_P * 3);
    var pPhase = new Float32Array(MAX_P);
    for (i = 0; i < MAX_P; i++) {
      pPos[i * 3 + 1] = -9999;      // 初始全部丢到远处
      pPhase[i] = i / MAX_P;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    var particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
      color: COLORS.running, size: 0.13, map: glowTex, transparent: true,
      opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    }));
    particles.frustumCulled = false;
    particles.visible = false;
    group.add(particles);

    /** 按环上的序号分配固定 8 个槽位（枢纽不占槽，第 10 个以后的节点自动降级无粒子） */
    function takeSlots(n) {
      if (n._slot >= 0 || n.isHub || !n.curve) { return; }
      var idx = -1, c = 0, k;
      for (k = 0; k < nodes.length; k++) {
        if (nodes[k].isHub) { continue; }
        if (nodes[k] === n) { idx = c; break; }
        c++;
      }
      if (idx < 0 || idx * SLOTS + SLOTS > MAX_P) { return; }
      n._slot = idx * SLOTS;
    }
    function freeSlots(n) {
      if (n._slot < 0) { return; }
      for (var k = 0; k < SLOTS; k++) { pPos[(n._slot + k) * 3 + 1] = -9999; }
      n._slot = -1;
      pGeo.attributes.position.needsUpdate = true;
    }

    /* ---------------- 五、状态设置 ---------------- */
    function applyStatus(id, status, note) {
      var n = nodeMap[id];
      if (!n) { return false; }
      if (!COLORS.hasOwnProperty(status)) { status = 'idle'; }
      n.status = status;
      n.note = note || '';
      n._colT.setHex(COLORS[status]);
      n._emiT.copy(_c1.setHex(COLORS[status]).multiplyScalar(0.12));
      // completed / failed：内部计时 2.4s 后自动回 idle（不用 setTimeout，避免泄漏）
      n._revertAt = (status === 'completed' || status === 'failed') ? elapsed + REVERT : 0;
      if (status === 'running') { takeSlots(n); } else { freeSlots(n); }
      return true;
    }

    function anyRunning() {
      for (var k = 0; k < nodes.length; k++) { if (nodes[k].status === 'running') { return true; } }
      return false;
    }

    /* ---------------- 六、每帧更新 ---------------- */
    function update(dt, t) {
      var d = (dt > 0) ? (dt > 0.1 ? 0.1 : dt) : 0; // 限幅，防标签页切回跳变
      elapsed += d;
      var now = (typeof t === 'number') ? t : elapsed;

      // 帧率无关的指数插值系数（不产生对象）
      var kS = 1 - Math.pow(0.001, d);
      var kO = 1 - Math.pow(0.002, d);
      var kC = 1 - Math.pow(0.0006, d);

      var n, st, target, appear, p, k = 0, i2, edgeDirty = false;

      for (i2 = 0; i2 < nodes.length; i2++) {
        n = nodes[i2];

        // 自动回落
        if (n._revertAt > 0 && elapsed >= n._revertAt) { applyStatus(n.agentId, 'idle', ''); }

        st = STYLE[n.status] || STYLE.idle;

        // 启动渐显因子
        appear = 1;
        if (progress < 1) {
          p = (progress - n._spawnAt) / (n.isHub ? 0.4 : 0.6);
          p = p < 0 ? 0 : (p > 1 ? 1 : p);
          appear = p * p * (3 - 2 * p); // smoothstep
        }

        // 目标缩放（悬停 ×1.25 优先）
        target = st.scale * appear;
        if (hoverId === n.agentId) { target *= HOVER_SCALE; }
        n._scale += (target - n._scale) * kS;
        n.group.scale.setScalar(n._scale > 0.0001 ? n._scale : 0.0001);

        // 光点透明度（脉冲由 gb/ga/gf 驱动）
        var gt = (st.gf > 0 ? st.gb + Math.sin(now * st.gf) * st.ga : st.gb) * appear;
        n._glow += (gt - n._glow) * kO;
        n.sMat.opacity = n._glow;
        n.glow.scale.setScalar(n.glowBase * (0.92 + gt * 0.16) * (appear > 0 ? 1 : 0));

        // 环转速
        n._spin += (st.spin - n._spin) * kO;
        n._angle += n._spin * d;
        n.ring.rotation.z = n._angle;
        if (n.ring2) {
          n.ring2.rotation.z = -n._angle * 0.72;
          n.ring2.rotation.y = n._angle * 0.45;
        }

        // 颜色插值：环 / 光点 / 边线 / 自发光 全部跟随状态色
        n._col.lerp(n._colT, kC);
        n.rMat.color.copy(n._elem);
        n.rMat.opacity = 0.42 + gt * 0.4;
        if (n.r2Mat) { n.r2Mat.color.copy(n._elem); n.r2Mat.opacity = 0.22 + gt * 0.30; }
        n.sMat.color.copy(n._col);            // 光点 = 状态色
        n.eMat.color.copy(n._elem);           // 边线 = 五行色
        n._emi.copy(n._elem).multiplyScalar(0.10 + gt * 0.42);  // 自发光 = 品牌色 × 状态强度
        n.pMat.emissive.copy(n._emi);

        // 边线透明度（悬停压到 0.7；low 质量隐藏）
        target = (hoverId === n.agentId) ? HOVER_EDGE : st.edge;
        if (quality === 'low') { target = 0; }
        n._edge += (target - n._edge) * kO;
        n.eMat.opacity = n._edge;
        n.eMat.visible = n._edge > 0.01;
        n.ring.visible = quality !== 'low';
        if (n.ring2) { n.ring2.visible = quality !== 'low'; }

        // thinking 抖动 ±0.01；其余归位
        if (st.jit > 0) {
          n.poly.position.set(
            Math.sin(now * 37.1 + i2) * st.jit,
            Math.cos(now * 41.7 + i2 * 1.3) * st.jit,
            Math.sin(now * 29.3 + i2 * 2.1) * st.jit
          );
        } else { n.poly.position.set(0, 0, 0); }
        n.poly.rotation.y += d * 0.16;
        n.poly.rotation.x += d * 0.05;

        // 连线强度（running 升到 0.22）：写成该连线顶点色 = 状态色 × 强度
        if (n.curve && n._vCount > 0) {
          n._link += (st.link * appear - n._link) * kO;
          if (quality !== 'low') {
            var cr = n._elem.r * n._link, cg = n._elem.g * n._link, cb = n._elem.b * n._link;
            var v0 = n._vStart * 3, v1 = v0 + n._vCount * 3;
            for (var q = v0; q < v1; q += 3) { edgeColors[q] = cr; edgeColors[q + 1] = cg; edgeColors[q + 2] = cb; }
            edgeDirty = true;
          }
        }

        if (n.status === 'running' && n._slot >= 0) { k++; }
      }

      // 连线顶点色统一提交（一次上传，1 个 draw call）
      if (edgeDirty && edgeGeo) { edgeGeo.attributes.color.needsUpdate = true; }

      // ---- 粒子：沿各自曲线 0→1 循环 ----
      var pOn = (quality !== 'low') && k > 0;
      if (particles.visible !== pOn) { particles.visible = pOn; }
      if (pOn) {
        for (i2 = 0; i2 < nodes.length; i2++) {
          n = nodes[i2];
          if (n._slot < 0 || !n.curve) { continue; }
          for (var s = 0; s < SLOTS; s++) {
            var pi = n._slot + s;
            if (pi >= MAX_P) { break; }
            pPhase[pi] += d * (0.32 + (s & 3) * 0.045);
            if (pPhase[pi] > 1) { pPhase[pi] -= 1; }
            n.curve.getPointAt(pPhase[pi], _v1);
            pPos[pi * 3] = _v1.x; pPos[pi * 3 + 1] = _v1.y; pPos[pi * 3 + 2] = _v1.z;
          }
        }
        pGeo.attributes.position.needsUpdate = true;
      }
    }

    /* ---------------- 七、对外 API ---------------- */
    var api = {
      group: group,
      pickables: pickables,
      update: update,

      setAgentStatus: function (agentId, status, note) {
        return applyStatus(agentId, status, note);
      },

      /** 后端 agent.created：插进外围环并重排、重建连线 */
      addAgent: function (opts) {
        if (!opts || !opts.agentId || nodeMap[opts.agentId]) { return null; }
        var n = mkNode(opts, false);
        nodes.push(n);
        nodeMap[n.agentId] = n;
        group.add(n.group);

        var ring = [], j;
        for (j = 0; j < nodes.length; j++) { if (!nodes[j].isHub) { ring.push(nodes[j]); } }
        for (j = 0; j < ring.length; j++) {
          var a = j * (Math.PI * 2 / ring.length) - Math.PI / 2;
          ring[j].group.position.set(Math.cos(a) * RING_R, Math.sin(j * 1.7) * 1.6 - 0.4, Math.sin(a) * RING_R);
          ring[j]._angle = a;
        }
        buildEdges(); // 位置变了，重建合并后的连线（仍只占 1 个 draw call）
        return n;
      },

      setVisible: function (v) { group.visible = !!v; },

      /** low：隐藏边线 / 状态环 / 流动粒子 */
      setQuality: function (q) {
        quality = (q === 'low') ? 'low' : 'high';
        var on = quality !== 'low';
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          n.eMat.visible = on; n.eMat.opacity = on ? n._edge : 0;
          n.ring.visible = on;
          if (n.ring2) { n.ring2.visible = on; }
        }
        if (edgeMesh) { edgeMesh.visible = on; }
        particles.visible = on && anyRunning();
      },

      /** 0–0.4 枢纽先出（scale 0→1）；0.4–1.0 其余错开 0.06 */
      setProgress: function (p) { progress = p < 0 ? 0 : (p > 1 ? 1 : p); },

      getAgent: function (agentId) { return nodeMap[agentId] || null; },

      /** hover 由外部 PAO.scene 调用 */
      setHover: function (agentId) { hoverId = agentId || null; },

      getSnapshot: function () {
        var out = [];
        for (var j = 0; j < nodes.length; j++) {
          out.push({ agentId: nodes[j].agentId, zh: nodes[j].zh, status: nodes[j].status, note: nodes[j].note });
        }
        return out;
      },

      dispose: function () {
        if (group.parent) { group.parent.remove(group); }
        for (var j = 0; j < nodes.length; j++) {
          nodes[j].pMat.dispose(); nodes[j].eMat.dispose(); nodes[j].rMat.dispose();
        }
        if (edgeGeo) { edgeGeo.dispose(); edgeMat.dispose(); }
        pGeo.dispose(); particles.material.dispose(); glowTex.dispose();
      }
    };

    /* ---------------- 八、事件自驱动（内部订阅，勿外部接线） ---------------- */
    if (PAO.bus && typeof PAO.bus.on === 'function') {
      PAO.bus.on('srv:agent.status.changed', function (p) {
        if (!p) { return; }
        var id = p.agentId || p.agent_id || p.id, to = p.to || p.status;
        if (id && to) { api.setAgentStatus(id, to, p.note); }
      });
      PAO.bus.on('srv:agent.created', function (p) {
        if (!p) { return; }
        var id = p.agentId || p.agent_id || p.id;
        if (id) { api.addAgent({ agentId: id, name: p.name || id, zh: p.zh || p.name || id }); }
      });
    }

    return api;
  };

  PAO.AGENT_COLORS = COLORS;
  PAO.AGENT_DEFS = function () { return buildDefs(); };

})(typeof window !== 'undefined' ? window : this);
