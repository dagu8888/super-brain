/* PERSONAL AI OS — 七层技术架构：悬浮层 / 网格 / 层间数据流 / 拆解 */
(function (PAO) {
  'use strict';

  PAO.buildArchitecture = function (data) {
    var group = new THREE.Group();
    group.name = 'architecture';
    group.visible = false;

    var layers = data.architecture ? data.architecture.layers : [];
    var items = [];
    var pickables = [];
    var explode = 0;
    var explodeTarget = 0;
    var activeIndex = -1;

    var BASE_SPACING = 1.55;
    var EXPLODE_SPACING = 2.85;
    var W = 7.6, H = 4.2;

    var gridShader = {
      uniforms: {
        uColor: { value: new THREE.Color(0x55ddf5) },
        uOpacity: { value: 0.5 },
        uActive: { value: 0.0 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOpacity; uniform float uActive;',
        'varying vec2 vUv;',
        'void main(){',
        '  vec2 g = vUv * vec2(22.0, 12.0);',
        '  vec2 f = abs(fract(g) - 0.5);',
        '  float line = smoothstep(0.46, 0.5, max(f.x, f.y));',
        '  float edge = 1.0 - smoothstep(0.0, 0.035, min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y)));',
        '  float a = (line * 0.35 + edge * 0.9) * uOpacity;',
        '  a *= 0.55 + uActive * 0.65;',
        '  vec3 col = uColor * (0.7 + uActive * 0.8);',
        '  gl_FragColor = vec4(col, a);',
        '}'
      ].join('\n')
    };

    layers.forEach(function (layer, i) {
      var g = new THREE.Group();
      var y = (i - (layers.length - 1) / 2) * BASE_SPACING;
      g.position.y = y;

      var mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(PAO.elementColor ? PAO.elementColor('layer', i) : (i >= 5 ? 0x9178ff : 0x55ddf5)) },
          uOpacity: { value: 0.34 },
          uActive: { value: 0 }
        },
        vertexShader: gridShader.vertexShader,
        fragmentShader: gridShader.fragmentShader
      });

      var plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H, 1, 1), mat);
      plane.rotation.x = -Math.PI / 2;
      g.add(plane);

      // 层序号标记：左侧立柱
      var pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, H * 0.9),
        new THREE.MeshBasicMaterial({ color: PAO.elementColor ? PAO.elementColor('layer', i) : 0x55ddf5, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending })
      );
      pillar.position.set(-W / 2, 0.02, 0);
      g.add(pillar);

      // 组件：层上小方块
      var compCount = (layer.components || []).length;
      var compMeshes = [];
      for (var c = 0; c < compCount; c++) {
        var cube = new THREE.Mesh(
          new THREE.BoxGeometry(0.22, 0.12, 0.22),
          new THREE.MeshBasicMaterial({
            color: 0x91dfff, transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false
          })
        );
        var cx = (-W / 2) + 1.0 + (c / Math.max(1, compCount - 1)) * (W - 2.0);
        cube.position.set(cx, 0.12, (c % 2 ? 0.55 : -0.55));
        g.add(cube);
        compMeshes.push(cube);
      }

      // 命中平面（透明）
      var hit = new THREE.Mesh(
        new THREE.PlaneGeometry(W, H),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
      );
      hit.rotation.x = -Math.PI / 2;
      hit.userData.pickKind = 'arch';
      hit.userData.pickId = 'L' + (i + 1);
      hit.userData.layerIndex = i;
      g.add(hit);
      pickables.push(hit);

      group.add(g);
      items.push({
        def: layer, group: g, plane: plane, mat: mat,
        comps: compMeshes, hit: hit, index: i,
        baseY: y, active: 0
      });
    });

    /* 层间数据流 */
    var flowGroup = new THREE.Group();
    var flows = [];
    for (var f = 0; f < 3; f++) {
      var geo = new THREE.BufferGeometry();
      var count = 26;
      var pos = new Float32Array(count * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var pts = new THREE.Points(geo, new THREE.PointsMaterial({
        color: f === 0 ? 0x55ddf5 : (f === 1 ? 0x91dfff : 0x9178ff),
        size: 0.1, transparent: true, opacity: 0.65,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
      }));
      flowGroup.add(pts);
      flows.push({ pts: pts, offset: f / 3, speed: 0.1 + f * 0.03 });
    }
    group.add(flowGroup);

    var api = {
      group: group,
      pickables: pickables,
      items: items,

      setLayer: function (i) {
        activeIndex = i;
      },
      getLayer: function () { return activeIndex; },

      setExplode: function (on) {
        explodeTarget = on ? 1 : 0;
      },

      setVisible: function (v) { group.visible = v; },

      setQuality: function (q) {
        items.forEach(function (it) {
          it.comps.forEach(function (c) { c.visible = q !== 'low'; });
        });
        flows.forEach(function (fl) { fl.pts.visible = q !== 'low'; });
      },

      reset: function () {
        activeIndex = -1;
        explodeTarget = 0;
      },

      update: function (dt, t) {
        if (!group.visible) return;

        explode += (explodeTarget - explode) * 0.07;
        var spacing = BASE_SPACING + (EXPLODE_SPACING - BASE_SPACING) * explode;

        items.forEach(function (it) {
          var targetY = (it.index - (items.length - 1) / 2) * spacing;
          it.group.position.y += (targetY - it.group.position.y) * 0.12;

          var isActive = activeIndex === it.index;
          it.active += ((isActive ? 1 : 0) - it.active) * 0.1;

          var targetOp = activeIndex === -1 ? 0.28 : (isActive ? 0.85 : 0.10);
          it.mat.uniforms.uOpacity.value += (targetOp - it.mat.uniforms.uOpacity.value) * 0.12;
          it.mat.uniforms.uActive.value = it.active;

          it.plane.scale.setScalar(1 + it.active * 0.045);
          it.comps.forEach(function (c, ci) {
            c.position.y = 0.1 + Math.sin(t * 1.4 + ci + it.index) * 0.04 + it.active * 0.1;
            c.material.opacity = (0.35 + it.active * 0.5);
          });
        });

        // 数据流沿垂直轴上升
        var top = (items.length - 1) / 2 * spacing + 1.2;
        var bottom = -(items.length - 1) / 2 * spacing - 1.2;
        flows.forEach(function (fl) {
          var attr = fl.pts.geometry.attributes.position;
          for (var k = 0; k < attr.count; k++) {
            var kk = k / attr.count;
            var y = bottom + ((t * fl.speed + kk + fl.offset) % 1) * (top - bottom);
            attr.array[k * 3] = Math.sin(y * 0.6 + fl.offset * 6) * 1.7;
            attr.array[k * 3 + 1] = y;
            attr.array[k * 3 + 2] = Math.cos(y * 0.45 + fl.offset * 4) * 1.2;
          }
          attr.needsUpdate = true;
        });

        group.rotation.y = Math.sin(t * 0.08) * 0.12;
      }
    };

    return api;
  };
})(window.PAO = window.PAO || {});
