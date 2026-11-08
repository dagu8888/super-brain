/* PERSONAL AI OS — 中央智能核心 PERSONAL INTELLIGENCE CORE
   结构：能量核 / 精密栅格球壳 / 环轨 / 神经网 / 轨道粒子 / 冲击波 */
(function (PAO) {
  'use strict';

  function radialTexture(inner, outer) {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  PAO.buildCore = function () {
    var group = new THREE.Group();
    group.name = 'core';

    var C_CYAN = new THREE.Color(0x55ddf5);
    var C_ICE = new THREE.Color(0x91dfff);
    var C_VIOLET = new THREE.Color(0x9178ff);

    /* ============ 1. 能量核 ============ */
    var nucleusMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 0 },
        uCyan: { value: C_CYAN },
        uIce: { value: C_ICE }
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vP;',
        'void main(){',
        '  vN = normalize(normalMatrix * normal);',
        '  vP = position;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float uTime; uniform float uPulse;',
        'uniform vec3 uCyan; uniform vec3 uIce;',
        'varying vec3 vN; varying vec3 vP;',
        'float band(float x, float w){ return smoothstep(w, 0.0, abs(x)); }',
        'void main(){',
        '  float fres = pow(1.0 - abs(dot(vN, vec3(0.0,0.0,1.0))), 2.2);',
        '  float t = uTime * 0.55;',
        '  float w1 = sin(vP.y * 7.0 + t * 2.0) * 0.5 + 0.5;',
        '  float w2 = sin(vP.x * 5.0 - t * 1.4) * 0.5 + 0.5;',
        '  float w3 = sin(vP.z * 9.0 + t * 2.6) * 0.5 + 0.5;',
        '  float veins = band(w1 * w2 - 0.42, 0.30) * 0.55 + band(w3 - 0.5, 0.22) * 0.35;',
        '  vec3 col = mix(uCyan, uIce, w1 * 0.8);',
        '  float core = 0.55 + 0.45 * fres;',
        '  float alpha = (0.11 + veins * 0.62 + fres * 0.42) * (0.55 + uPulse * 0.9);',
        '  col += vec3(0.25,0.42,0.5) * uPulse;',
        '  gl_FragColor = vec4(col * core, clamp(alpha,0.0,1.0));',
        '}'
      ].join('\n')
    });
    var nucleus = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 4), nucleusMat);
    group.add(nucleus);

    /* 内层：极小的致密核，避免读成"行星" */
    var solid = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.34, 1),
      new THREE.MeshBasicMaterial({ color: 0x0d2b3c, transparent: true, opacity: 0.7 })
    );
    group.add(solid);

    var innerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture('rgba(190,246,255,0.95)', 'rgba(60,180,225,0.42)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    innerGlow.scale.setScalar(4.6);
    group.add(innerGlow);

    /* ============ 2. 精密栅格球壳 ×2 ============ */
    function gridShell(radius, density, opacity, colorHex) {
      var mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uOpacity: { value: opacity },
          uDensity: { value: density },
          uColor: { value: new THREE.Color(colorHex) },
          uTime: { value: 0 }
        },
        vertexShader: [
          'varying vec3 vP; varying vec3 vN;',
          'void main(){ vP = position; vN = normalize(normalMatrix*normal);',
          ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
        ].join('\n'),
        fragmentShader: [
          'uniform float uOpacity; uniform float uDensity; uniform vec3 uColor; uniform float uTime;',
          'varying vec3 vP; varying vec3 vN;',
          'void main(){',
          '  vec3 n = normalize(vP);',
          '  float lat = acos(clamp(n.y,-1.0,1.0));',
          '  float lon = atan(n.z, n.x);',
          '  float a = abs(cos(lat * uDensity));',
          '  float b = abs(cos(lon * (uDensity * 1.15)));',
          '  float line = smoothstep(0.972, 1.0, max(a,b));',
          '  float fres = pow(1.0 - abs(dot(vN, vec3(0.0,0.0,1.0))), 1.8);',
          '  float alpha = line * (0.30 + fres * 0.75) * uOpacity;',
          '  gl_FragColor = vec4(uColor, alpha);',
          '}'
        ].join('\n')
      });
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 54, 36), mat);
      return mesh;
    }

    var shellOuter = gridShell(2.55, 8.0, 0.34, 0x4fb6d8);
    var shellInner = gridShell(1.78, 13.0, 0.40, 0x7fd6f0);
    group.add(shellOuter, shellInner);

    /* 半透明玻璃球：极淡，制造体积 */
    var glassMat = new THREE.MeshBasicMaterial({
      color: 0x2e7ea0, transparent: true, opacity: 0.028,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var glass = new THREE.Mesh(new THREE.SphereGeometry(2.62, 32, 24), glassMat);
    group.add(glass);

    /* ============ 3. 环轨 ×3 + 刻度 ============ */
    var rings = new THREE.Group();
    var E = PAO.ELEMENTS || null;
    var ringDefs = [
      { r: 3.05, tube: 0.008, tilt: [1.20, 0.10, 0.35], speed: 0.16, color: E ? E.wood.color : 0x55ddf5, ticks: 60 },
      { r: 3.52, tube: 0.006, tilt: [1.62, -0.42, 0.15], speed: -0.115, color: E ? E.fire.color : 0x9178ff, ticks: 72 },
      { r: 3.98, tube: 0.006, tilt: [1.42, 0.62, -0.22], speed: 0.09, color: E ? E.earth.color : 0x91dfff, ticks: 54 },
      { r: 4.42, tube: 0.005, tilt: [1.75, 0.22, 0.48], speed: -0.072, color: E ? E.metal.color : 0xc8d4e4, ticks: 42 },
      { r: 4.86, tube: 0.005, tilt: [1.30, -0.68, 0.10], speed: 0.058, color: E ? E.water.color : 0x4e86d9, ticks: 36 }
    ];
    var ringObjs = [];

    ringDefs.forEach(function (def) {
      var g = new THREE.Group();
      g.rotation.set(def.tilt[0], def.tilt[1], def.tilt[2]);

      var torus = new THREE.Mesh(
        new THREE.TorusGeometry(def.r, def.tube, 6, 180),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending })
      );
      torus.rotation.x = Math.PI / 2;
      g.add(torus);

      // 刻度
      var tickGeo = new THREE.BoxGeometry(0.012, 0.012, 0.16);
      var tickMat = new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending });
      var ticks = new THREE.InstancedMesh(tickGeo, tickMat, def.ticks);
      var dummy = new THREE.Object3D();
      for (var i = 0; i < def.ticks; i++) {
        var a = (i / def.ticks) * Math.PI * 2;
        dummy.position.set(Math.cos(a) * def.r, 0, Math.sin(a) * def.r);
        dummy.rotation.set(0, -a, 0);
        var big = (i % Math.round(def.ticks / 6) === 0);
        dummy.scale.set(1, 1, big ? 2.4 : 1);
        dummy.updateMatrix();
        ticks.setMatrixAt(i, dummy.matrix);
      }
      ticks.instanceMatrix.needsUpdate = true;
      g.add(ticks);

      rings.add(g);
      ringObjs.push({ g: g, torus: torus, ticks: ticks, speed: def.speed, base: def.tilt[1] });
    });
    group.add(rings);

    /* ============ 4. 神经网络（球面节点 + 近邻连线）============ */
    var netGroup = new THREE.Group();
    var NODE_COUNT = 108;
    var nodePts = [];
    for (var i = 0; i < NODE_COUNT; i++) {
      var y = 1 - (i / (NODE_COUNT - 1)) * 2;
      var radius = Math.sqrt(Math.max(0, 1 - y * y));
      var theta = i * 2.399963;
      var vr = 3.0 + Math.sin(i * 1.7) * 0.18;
      nodePts.push(new THREE.Vector3(Math.cos(theta) * radius * vr, y * vr * 0.96, Math.sin(theta) * radius * vr));
    }

    var linePositions = [];
    var lineColors = [];
    var maxDist = 1.55;
    for (var a = 0; a < nodePts.length; a++) {
      var links = 0;
      for (var b = a + 1; b < nodePts.length && links < 2; b++) {
        if (nodePts[a].distanceTo(nodePts[b]) < maxDist) {
          linePositions.push(nodePts[a].x, nodePts[a].y, nodePts[a].z, nodePts[b].x, nodePts[b].y, nodePts[b].z);
          var ca = (a % 5 === 0) ? C_VIOLET : C_CYAN;
          lineColors.push(ca.r * 0.32, ca.g * 0.32, ca.b * 0.32, ca.r * 0.1, ca.g * 0.1, ca.b * 0.1);
          links++;
        }
      }
    }
    var lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    var netLines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    netGroup.add(netLines);

    var nodeGeo = new THREE.BufferGeometry().setFromPoints(nodePts);
    var nodeMat = new THREE.PointsMaterial({
      color: 0xa8ecff, size: 0.062, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, depthWrite: false
    });
    var netNodes = new THREE.Points(nodeGeo, nodeMat);
    netGroup.add(netNodes);
    group.add(netGroup);

    /* ============ 5. 轨道粒子 ============ */
    var P_COUNT = 1500;
    var pGeo = new THREE.BufferGeometry();
    var pPos = new Float32Array(P_COUNT * 3);
    var pSize = new Float32Array(P_COUNT);
    var pSeed = new Float32Array(P_COUNT);
    var pRad = new Float32Array(P_COUNT);
    var pY = new Float32Array(P_COUNT);

    for (var p = 0; p < P_COUNT; p++) {
      var rr = 2.05 + Math.pow(Math.random(), 0.85) * 2.85;
      var ang = Math.random() * Math.PI * 2;
      var yy = (Math.random() - 0.5) * 2.2 * (rr / 4.9);
      pRad[p] = rr;
      pY[p] = yy;
      pPos[p * 3] = Math.cos(ang) * rr;
      pPos[p * 3 + 1] = yy;
      pPos[p * 3 + 2] = Math.sin(ang) * rr;
      pSize[p] = 0.6 + Math.random() * 2.0;
      pSeed[p] = Math.random();
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));

    var particleMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1.0 },
        uPixel: { value: 1.0 },
        uCyan: { value: C_CYAN },
        uIce: { value: C_ICE }
      },
      vertexShader: [
        'attribute float aSize; attribute float aSeed;',
        'uniform float uTime; uniform float uPixel;',
        'varying float vSeed; varying float vFade;',
        'void main(){',
        '  vec3 pos = position;',
        '  float sp = 0.06 + aSeed * 0.14;',
        '  float ang = uTime * sp * (aSeed > 0.5 ? 1.0 : -1.0);',
        '  float c = cos(ang), s = sin(ang);',
        '  vec3 rot = vec3(pos.x * c - pos.z * s, pos.y, pos.x * s + pos.z * c);',
        '  rot.y += sin(uTime * 0.5 + aSeed * 6.28) * 0.16;',
        '  vSeed = aSeed;',
        '  vec4 mv = modelViewMatrix * vec4(rot, 1.0);',
        '  gl_PointSize = aSize * uPixel * (140.0 / max(0.001, -mv.z));',
        '  gl_Position = projectionMatrix * mv;',
        '  vFade = clamp(1.0 - (-mv.z - 6.0) / 34.0, 0.05, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float uOpacity; uniform vec3 uCyan; uniform vec3 uIce;',
        'varying float vSeed; varying float vFade;',
        'void main(){',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float r = length(d);',
        '  if (r > 0.5) discard;',
        '  float soft = smoothstep(0.5, 0.0, r);',
        '  float a = soft * soft * vFade * uOpacity * (0.35 + vSeed * 0.65);',
        '  vec3 col = mix(uCyan, uIce, vSeed);',
        '  gl_FragColor = vec4(col, a);',
        '}'
      ].join('\n')
    });
    var particles = new THREE.Points(pGeo, particleMat);
    group.add(particles);

    /* ============ 6. 冲击波池 ============ */
    var shockwaves = [];
    for (var s = 0; s < 3; s++) {
      var sw = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.06, 96),
        new THREE.MeshBasicMaterial({ color: 0x91dfff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      sw.visible = false;
      sw.userData.life = 0;
      group.add(sw);
      shockwaves.push(sw);
    }
    var shockIndex = 0;

    /* ============ 7. 命中体（用于 dblclick 回中心）============ */
    var hitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 12, 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitMesh.userData.pickKind = 'core';
    hitMesh.userData.pickId = 'core';
    group.add(hitMesh);

    /* ============ API ============ */
    var progress = 1;
    var dim = 0;

    var api = {
      group: group,
      nucleus: nucleus,
      pickables: [hitMesh],
      position: new THREE.Vector3(0, 0, 0),

      pulse: function (color) {
        var sw = shockwaves[shockIndex % shockwaves.length];
        shockIndex++;
        sw.visible = true;
        sw.userData.life = 1;
        sw.scale.setScalar(1.1);
        sw.material.opacity = 0.55;
        sw.material.color.set(color || 0x91dfff);
      },

      setDim: function (v) { dim = v; },

      setProgress: function (p) {
        progress = p;
        var awaken = Math.min(1, Math.max(0, (p - 0.10) / 0.26));
        var ignite = Math.min(1, Math.max(0, (p - 0.34) / 0.24));
        var deploy = Math.min(1, Math.max(0, (p - 0.55) / 0.28));

        nucleusMat.uniforms.uPulse.value = ignite;
        solid.material.opacity = 0.7 * ignite;
        innerGlow.material.opacity = ignite * (0.85);

        shellOuter.material.uniforms.uOpacity.value = 0.34 * deploy;
        shellInner.material.uniforms.uOpacity.value = 0.40 * deploy;
        glassMat.opacity = 0.028 * deploy;

        rings.scale.setScalar(0.55 + 0.45 * deploy);
        rings.visible = deploy > 0.02;

        netGroup.scale.setScalar(0.4 + 0.6 * deploy);
        netGroup.visible = deploy > 0.02;
        netLines.material.opacity = 0.5 * deploy;
        nodeMat.opacity = 0.85 * deploy;

        particleMat.uniforms.uOpacity.value = awaken;
        particles.scale.setScalar(2.1 - 1.1 * awaken);
        particles.visible = awaken > 0.01;
        group.visible = p > 0.02;
      },

      setQuality: function (q) {
        particleMat.uniforms.uPixel.value = q === 'low' ? 0.62 : 0.82;
        pGeo.setDrawRange(0, q === 'low' ? 620 : P_COUNT);
        netGroup.visible = q !== 'low';
        shellOuter.material.uniforms.uDensity.value = q === 'low' ? 6 : 8;
      },

      update: function (dt, t) {
        nucleusMat.uniforms.uTime.value = t;
        shellOuter.material.uniforms.uTime.value = t;
        shellInner.material.uniforms.uTime.value = t;
        particleMat.uniforms.uTime.value = t;

        nucleus.rotation.y += dt * 0.12;
        nucleus.rotation.x = Math.sin(t * 0.2) * 0.12;
        shellOuter.rotation.y -= dt * 0.045;
        shellInner.rotation.y += dt * 0.07;
        shellInner.rotation.z = Math.sin(t * 0.15) * 0.06;
        netGroup.rotation.y += dt * 0.028;
        netGroup.rotation.z = Math.cos(t * 0.12) * 0.04;

        ringObjs.forEach(function (r, i) {
          r.g.rotation.y += dt * r.speed;
          r.ticks.material.opacity = 0.3 + Math.sin(t * 0.9 + i) * 0.12;
        });

        var breathe = 1 + Math.sin(t * 0.9) * 0.035;
        innerGlow.scale.setScalar(4.6 * breathe * (0.9 + 0.1 * progress));

        for (var i2 = 0; i2 < shockwaves.length; i2++) {
          var sw = shockwaves[i2];
          if (!sw.visible) continue;
          sw.userData.life -= dt * 0.85;
          if (sw.userData.life <= 0) { sw.visible = false; continue; }
          var k = 1 - sw.userData.life;
          sw.scale.setScalar(1.1 + k * 5.5);
          sw.material.opacity = 0.5 * (1 - k) * (1 - k);
          sw.lookAt(PAO.engine.camera.position);
        }

        // 选中模块时整体压暗
        var targetDim = dim ? 0.42 : 1;
        particles.material.uniforms.uOpacity.value += (targetDim - particles.material.uniforms.uOpacity.value) * 0.06;
      }
    };

    api.setProgress(0);
    return api;
  };
})(window.PAO = window.PAO || {});
