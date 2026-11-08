/* PERSONAL AI OS — 六大系统模块：空间分布 / 独立形态 / 状态 / 数据流 */
(function (PAO) {
  'use strict';

  var DEFS = [
    { id: 'memory', num: '01', name: 'PERSONAL MEMORY', zh: '记忆系统', color: 0x55ddf5, shape: 'icosa', angle: -Math.PI / 2, radius: 7.6, y: 0.6 },
    { id: 'cognitive', num: '02', name: 'COGNITIVE ENGINE', zh: '认知引擎', color: 0x7fd6f0, shape: 'octa', angle: -Math.PI / 2 + Math.PI / 3, radius: 8.7, y: -1.0 },
    { id: 'agent', num: '03', name: 'AGENT RUNTIME', zh: '智能体运行时', color: 0x9178ff, shape: 'box', angle: -Math.PI / 2 + Math.PI * 2 / 3, radius: 7.5, y: 2.0 },
    { id: 'data', num: '04', name: 'DATA UNIVERSE', zh: '数据宇宙', color: 0x4fb6d8, shape: 'dodeca', angle: -Math.PI / 2 + Math.PI, radius: 8.9, y: -0.5 },
    { id: 'model', num: '05', name: 'MODEL GATEWAY', zh: '模型网关', color: 0x91dfff, shape: 'knot', angle: -Math.PI / 2 + Math.PI * 4 / 3, radius: 7.3, y: 2.3 },
    { id: 'trust', num: '06', name: 'PERMISSION & TRUST', zh: '权限与信任', color: 0x8fb4e0, shape: 'shield', angle: -Math.PI / 2 + Math.PI * 5 / 3, radius: 8.6, y: -1.4 }
  ];

  function makeGeometry(shape) {
    switch (shape) {
      case 'icosa': return new THREE.IcosahedronGeometry(0.54, 1);
      case 'octa': return new THREE.OctahedronGeometry(0.62, 0);
      case 'box': return new THREE.BoxGeometry(0.56, 0.56, 0.56);
      case 'dodeca': return new THREE.DodecahedronGeometry(0.56, 0);
      case 'knot': return new THREE.TorusKnotGeometry(0.31, 0.10, 96, 10);
      case 'shield': return new THREE.IcosahedronGeometry(0.6, 0);
      default: return new THREE.IcosahedronGeometry(0.55, 1);
    }
  }

  function radialSprite(hex, size) {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var col = new THREE.Color(hex);
    var r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255);
    var grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.22, 'rgba(' + r + ',' + g + ',' + b + ',0.55)');
    grad.addColorStop(0.55, 'rgba(' + r + ',' + g + ',' + b + ',0.12)');
    grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return { tex: tex, size: size };
  }

  PAO.buildModules = function () {
    var group = new THREE.Group();
    group.name = 'modules';

    /* 五行身份色：模块色相 = 它属于哪一行（状态色另由 scene-agents 的光点承担） */
    if (PAO.elementColor) {
      DEFS.forEach(function (d) { d.color = PAO.elementColor('module', d.id); d.element = PAO.elementOf('module', d.id).id; });
    }

    var lights = new THREE.Group();
    var amb = new THREE.AmbientLight(0x2b4a68, 1.0);
    var key = new THREE.PointLight(0x66d8ff, 1.55, 60, 2);
    key.position.set(0, 4, 10);
    var rim = new THREE.PointLight(0x6274ff, 0.65, 70, 2);
    rim.position.set(-11, -5, -10);
    lights.add(amb, key, rim);
    group.add(lights);

    var items = [];
    var pickables = [];
    var corePos = new THREE.Vector3(0, 0, 0);

    DEFS.forEach(function (def, index) {
      var node = new THREE.Group();
      var a = def.angle;
      node.position.set(Math.cos(a) * def.radius, def.y, Math.sin(a) * def.radius);

      var color = new THREE.Color(def.color);

      /* 主体：真实受光材质 */
      var geo = makeGeometry(def.shape);
      var mat = new THREE.MeshStandardMaterial({
        color: 0x0b1824,
        emissive: color.clone().multiplyScalar(0.11),
        emissiveIntensity: 1,
        metalness: 0.74,
        roughness: 0.36,
        transparent: true,
        opacity: 1,
        flatShading: def.shape === 'icosa' || def.shape === 'dodeca' || def.shape === 'octa'
      });
      var mesh = new THREE.Mesh(geo, mat);
      node.add(mesh);

      /* 线框外壳 */
      var cage = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 12),
        new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending })
      );
      cage.scale.setScalar(1.22);
      node.add(cage);

      /* 精修环 */
      var halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.98, 0.006, 4, 96),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending })
      );
      halo.rotation.x = Math.PI / 2.3;
      node.add(halo);

      var halo2 = new THREE.Mesh(
        new THREE.TorusGeometry(1.24, 0.004, 4, 96),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending })
      );
      halo2.rotation.set(Math.PI / 1.7, 0.5, 0);
      node.add(halo2);

      /* 光晕 */
      var rs = radialSprite(def.color, 3.1);
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: rs.tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.5
      }));
      glow.scale.setScalar(3.1);
      node.add(glow);

      /* 命中体 */
      var hit = new THREE.Mesh(
        new THREE.SphereGeometry(1.15, 10, 8),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hit.userData.pickKind = 'module';
      hit.userData.pickId = def.id;
      node.add(hit);
      pickables.push(hit);

      /* 连接曲线 + 流动粒子 */
      var start = new THREE.Vector3(0, 0, 0);
      var end = node.position.clone();
      var mid = end.clone().multiplyScalar(0.5);
      mid.y += 1.6 + (index % 3) * 0.5;
      var curve = new THREE.QuadraticBezierCurve3(start, mid, end);

      var tubeGeo = new THREE.TubeGeometry(curve, 40, 0.008, 4, false);
      var tubeMat = new THREE.MeshBasicMaterial({
        color: def.color, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var tube = new THREE.Mesh(tubeGeo, tubeMat);
      group.add(tube);

      var FLOW = 30;
      var flowGeo = new THREE.BufferGeometry();
      var flowPos = new Float32Array(FLOW * 3);
      flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
      var flowMat = new THREE.PointsMaterial({
        color: def.color, size: 0.11, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
      });
      var flow = new THREE.Points(flowGeo, flowMat);
      group.add(flow);
      var flowT = [];
      for (var f = 0; f < FLOW; f++) flowT.push(f / FLOW);

      group.add(node);

      items.push({
        def: def,
        node: node,
        mesh: mesh,
        mat: mat,
        cage: cage,
        halo: halo,
        halo2: halo2,
        glow: glow,
        tube: tube,
        tubeMat: tubeMat,
        flow: flow,
        flowT: flowT,
        hit: hit,
        ctrl: mid,
        baseY: def.y,
        phase: index * 1.13,
        hover: 0,
        active: 0,
        targetActive: 0,
        targetHover: 0,
        emerge: 0,
        index: index
      });
    });

    var activeId = null;

    var api = {
      group: group,
      items: items,
      pickables: pickables,
      corePos: corePos,

      getItem: function (id) {
        for (var i = 0; i < items.length; i++) if (items[i].def.id === id) return items[i];
        return null;
      },

      setHover: function (id) {
        items.forEach(function (it) { it.targetHover = (it.def.id === id) ? 1 : 0; });
      },

      setActive: function (id) {
        activeId = id;
        items.forEach(function (it) { it.targetActive = (it.def.id === id) ? 1 : 0; });
      },

      getActive: function () { return activeId; },

      pulse: function (id) {
        var it = api.getItem(id);
        if (!it) return;
        it.pulseT = 1;
      },

      setProgress: function (p) {
        // 模块在 0.58 → 0.94 之间依次显现
        var start = 0.58, span = 0.36;
        items.forEach(function (it, i) {
          var local = (p - (start + (i / items.length) * span)) / 0.10;
          it.emerge = Math.max(0, Math.min(1, local));
        });
      },

      setQuality: function (q) {
        items.forEach(function (it) {
          it.cage.visible = q !== 'low';
          it.halo2.visible = q !== 'low';
          it.flow.visible = q !== 'low';
          it.tube.visible = q !== 'low';
        });
      },

      update: function (dt, t) {
        items.forEach(function (it) {
          it.hover += (it.targetHover - it.hover) * 0.12;
          it.active += (it.targetActive - it.active) * 0.10;

          var e = it.emerge;
          var scale = (0.25 + 0.75 * e) * (1 + it.hover * 0.14 + it.active * 0.26);
          it.node.scale.setScalar(scale);
          it.node.visible = e > 0.01;

          it.node.position.y = it.baseY + Math.sin(t * 0.55 + it.phase) * 0.22;

          it.mesh.rotation.x += dt * (0.18 + it.active * 0.5);
          it.mesh.rotation.y += dt * (0.26 + it.hover * 0.3);
          it.cage.rotation.y -= dt * 0.22;
          it.cage.rotation.x += dt * 0.08;
          it.halo.rotation.z += dt * (0.4 + it.hover * 1.2);
          it.halo2.rotation.z -= dt * 0.26;

          var glowBase = 0.28 + it.hover * 0.35 + it.active * 0.55;
          it.glow.material.opacity = glowBase * e;
          it.glow.scale.setScalar((3.1 + it.hover * 0.5 + it.active * 0.8) * (0.6 + 0.4 * e));

          it.mat.emissiveIntensity = 0.8 + it.hover * 1.1 + it.active * 2.8;
          it.cage.material.opacity = (0.2 + it.hover * 0.3 + it.active * 0.4) * e;

          it.tubeMat.opacity = (0.18 + it.hover * 0.18 + it.active * 0.34) * e;
          it.flow.material.opacity = (0.55 + it.active * 0.45) * e;

          // 数据流：沿曲线推进
          if (it.flow.visible && e > 0.02) {
            var posAttr = it.flow.geometry.attributes.position;
            for (var k = 0; k < it.flowT.length; k++) {
              it.flowT[k] += dt * 0.16;
              if (it.flowT[k] > 1) it.flowT[k] -= 1;
              var tt = it.flowT[k];
              var p0 = corePos, p2 = it.node.position, p1 = it.ctrl;
              var one = 1 - tt;
              var x = one * one * p0.x + 2 * one * tt * p1.x + tt * tt * p2.x;
              var y = one * one * p0.y + 2 * one * tt * p1.y + tt * tt * p2.y;
              var z = one * one * p0.z + 2 * one * tt * p1.z + tt * tt * p2.z;
              posAttr.array[k * 3] = x;
              posAttr.array[k * 3 + 1] = y;
              posAttr.array[k * 3 + 2] = z;
            }
            posAttr.needsUpdate = true;
          }

          // 选中时其他模块压暗
          var others = (activeId && activeId !== it.def.id) ? 0.42 : 1;
          it.mat.opacity = others * (0.55 + 0.45 * e);
          it.glow.material.opacity *= others;

          if (it.pulseT) {
            it.pulseT -= dt * 1.6;
            if (it.pulseT <= 0) { it.pulseT = 0; }
            var pp = 1 - it.pulseT;
            it.node.scale.setScalar(scale * (1 + pp * 0.35));
          }
        });
      }
    };

    api.setProgress(0);
    return api;
  };
})(window.PAO = window.PAO || {});
