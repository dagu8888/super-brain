/* PERSONAL AI OS / DSH — Obsidian 知识图谱三维视图
   数据来自 server/obsidian.mjs（/api/graph）。
   布局：文件夹分扇区 → 力导向迭代（一次算完，不实时跑，保性能）。
   渲染：节点 1 个 Points（1 draw call）+ 边 2 组 LineSegments（2 draw call）。 */
(function (PAO) {
  'use strict';

  var FOLDER_COLORS = {
    'Decisions': 0xE5674E, 'Preferences': 0x3FBF8F, 'Knowledge': 0xD9A93C,
    'Projects': 0x4E86D9, 'Profile': 0xCFD8E6, 'Experiences': 0x55DDF5,
    'Conflicts': 0xE06767, '架构': 0x9178FF, 'Index': 0x8FA3BF,
    'Tasks': 0x7FD6F0, 'History': 0x6E8AA8, 'Inbox': 0x7E8999,
    /* 云脑（超级大脑）知识库分类 */
    'Concepts': 0xD9A93C, 'Playbooks': 0x3FBF8F, 'Unsorted': 0x7E8999
  };

  function colorForFolder(f) {
    if (!f) return 0x7E8999;
    var root = String(f).split('/')[0];
    return FOLDER_COLORS[root] != null ? FOLDER_COLORS[root] : 0x6E8AA8;
  }

  PAO.buildGraphScene = function () {
    var group = new THREE.Group();
    group.name = 'knowledge-graph';
    group.visible = false;

    var nodes = [];          // 数据
    var nodeIndex = new Map(); // id -> index
    var positions = null;    // Float32Array
    var points = null;
    var linkLines = null, tagLines = null;
    var pickMeshes = [];
    var hovered = -1, selected = -1;
    var hoverRing = null;
    var radii = null, colors = null, sizes = null;

    /* ---------------- 布局 ---------------- */
    function computeLayout(list, edges) {
      var n = list.length;
      var pos = new Float32Array(n * 3);
      var R = 13;

      /* ① 按文件夹分扇区，初始球形分布 */
      var folders = {};
      list.forEach(function (nd, i) {
        var f = nd.folder || '.';
        if (!folders[f]) folders[f] = [];
        folders[f].push(i);
      });
      var fKeys = Object.keys(folders);
      var fIdx = 0;
      for (var k = 0; k < fKeys.length; k++) {
        var ids = folders[fKeys[k]];
        var baseAng = (fIdx / Math.max(1, fKeys.length)) * Math.PI * 2;
        fIdx++;
        for (var j = 0; j < ids.length; j++) {
          var i = ids[j];
          var a = baseAng + (j / Math.max(1, ids.length)) * 0.9;
          var rad = R * (0.55 + 0.45 * ((j * 37 % 11) / 11));
          var y = Math.sin(i * 2.1) * 3.2;
          pos[i * 3] = Math.cos(a) * rad;
          pos[i * 3 + 1] = y;
          pos[i * 3 + 2] = Math.sin(a) * rad;
        }
      }

      /* ② 力导向迭代（斥力 + 边引力 + 向心），一次算完 */
      var idx = new Map();
      list.forEach(function (nd, i) { idx.set(nd.id, i); });
      var E = [];
      edges.forEach(function (e) {
        var a = idx.get(e.from), b = idx.get(e.to);
        if (a != null && b != null && a !== b) E.push([a, b, e.kind === 'link' ? 1 : 0.35]);
      });

      var ITER = 90;
      var tmp = new Float32Array(n * 3);
      for (var it = 0; it < ITER; it++) {
        for (var q = 0; q < tmp.length; q++) tmp[q] = 0;

        /* 斥力（采样加速：只与邻近的若干节点算，避免 O(n²) 抖动） */
        for (var a1 = 0; a1 < n; a1++) {
          for (var b1 = a1 + 1; b1 < n; b1++) {
            var dx = pos[a1 * 3] - pos[b1 * 3];
            var dy = pos[a1 * 3 + 1] - pos[b1 * 3 + 1];
            var dz = pos[a1 * 3 + 2] - pos[b1 * 3 + 2];
            var d2 = dx * dx + dy * dy + dz * dz + 0.01;
            if (d2 > 90) continue;                 // 远处忽略，控制计算量
            var f = 2.2 / d2;
            tmp[a1 * 3] += dx * f; tmp[a1 * 3 + 1] += dy * f; tmp[a1 * 3 + 2] += dz * f;
            tmp[b1 * 3] -= dx * f; tmp[b1 * 3 + 1] -= dy * f; tmp[b1 * 3 + 2] -= dz * f;
          }
        }

        /* 边引力 */
        for (var e2 = 0; e2 < E.length; e2++) {
          var A = E[e2][0], B = E[e2][1], w = E[e2][2];
          var ex = pos[B * 3] - pos[A * 3];
          var ey = pos[B * 3 + 1] - pos[A * 3 + 1];
          var ez = pos[B * 3 + 2] - pos[A * 3 + 2];
          var ed = Math.sqrt(ex * ex + ey * ey + ez * ez) + 0.01;
          var ef = (ed - (w > 0.5 ? 1.9 : 3.6)) * 0.016 * w;
          tmp[A * 3] += ex * ef; tmp[A * 3 + 1] += ey * ef; tmp[A * 3 + 2] += ez * ef;
          tmp[B * 3] -= ex * ef; tmp[B * 3 + 1] -= ey * ef; tmp[B * 3 + 2] -= ez * ef;
        }

        /* 向心 + 应用 */
        var damp = 0.55 * (1 - it / ITER * 0.4);
        for (var i2 = 0; i2 < n; i2++) {
          var px = pos[i2 * 3], py = pos[i2 * 3 + 1], pz = pos[i2 * 3 + 2];
          tmp[i2 * 3] -= px * 0.0016;
          tmp[i2 * 3 + 1] -= py * 0.0016;
          tmp[i2 * 3 + 2] -= pz * 0.0016;
          var nx = px + tmp[i2 * 3] * damp;
          var ny = py + tmp[i2 * 3 + 1] * damp;
          var nz = pz + tmp[i2 * 3 + 2] * damp;
          var len = Math.sqrt(nx * nx + ny * ny + nz * nz) + 0.001;
          if (len > R * 1.35) { var s = (R * 1.35) / len; nx *= s; ny *= s; nz *= s; }
          pos[i2 * 3] = nx; pos[i2 * 3 + 1] = ny; pos[i2 * 3 + 2] = nz;
        }
      }
      return pos;
    }

    /* ---------------- 构建 ---------------- */
    function build(graph) {
      /* 清理 */
      while (group.children.length) {
        var c = group.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      }
      pickMeshes = []; nodeIndex.clear();

      nodes = graph.nodes || [];
      var edges = graph.edges || [];
      var n = nodes.length;
      if (!n) return;

      positions = computeLayout(nodes, edges);
      colors = new Float32Array(n * 3);
      radii = new Float32Array(n);
      sizes = new Float32Array(n);

      var c = new THREE.Color();
      nodes.forEach(function (nd, i) {
        nodeIndex.set(nd.id, i);
        c.setHex(nd.isIndex ? 0x8FA3BF : colorForFolder(nd.folder));
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        /* 尺寸：索引页淡而大，知识节点按度数 */
        radii[i] = nd.isIndex ? 2.6 : 0.9 + Math.min(2.2, nd.degree * 0.22);
        sizes[i] = nd.isIndex ? 0.55 : 0.85 + Math.min(1.5, nd.degree * 0.12);
      });

      /* 节点 Points */
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

      var mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uPixel: { value: 1 } },
        vertexShader: [
          'attribute vec3 aColor; attribute float aSize;',
          'uniform float uTime; uniform float uPixel;',
          'varying vec3 vColor; varying float vFade;',
          'void main(){',
          '  vColor = aColor;',
          '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
          '  float breathe = 1.0 + sin(uTime * 1.1 + position.x * 0.3) * 0.06;',
          '  gl_PointSize = aSize * uPixel * breathe * (260.0 / max(1.0, -mv.z));',
          '  gl_Position = projectionMatrix * mv;',
          '  vFade = clamp(1.0 - (-mv.z - 12.0) / 40.0, 0.15, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vColor; varying float vFade;',
          'uniform float uOpacity;',
          'void main(){',
          '  vec2 d = gl_PointCoord - vec2(0.5);',
          '  float r = length(d);',
          '  if (r > 0.5) discard;',
          '  float core = smoothstep(0.5, 0.0, r);',
          '  float halo = smoothstep(0.5, 0.28, r);',
          '  vec3 col = mix(vColor, vec3(1.0), core * 0.5);',
          '  gl_FragColor = vec4(col, (core * 0.85 + halo * 0.25) * vFade * uOpacity);',
          '}'
        ].join('\n')
      });
      points = new THREE.Points(geo, mat);
      group.add(points);

      /* 边分三组：强链接 / 索引链接（极淡，否则星形爆炸） / 标签 */
      var linkPos = [], indexPos = [], tagPos = [];
      var indexSet = new Set();
      nodes.forEach(function (nd, i) { if (nd.isIndex) indexSet.add(nd.id); });

      edges.forEach(function (e) {
        var a = nodeIndex.get(e.from), b = nodeIndex.get(e.to);
        if (a == null || b == null) return;
        var arr;
        if (e.kind === 'tag') arr = tagPos;
        else if (indexSet.has(e.from) || indexSet.has(e.to)) arr = indexPos;  // 索引页发出的边
        else arr = linkPos;
        arr.push(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
        arr.push(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
      });

      function mkLines(arr, opacity, color) {
        if (!arr.length) return null;
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        var m = new THREE.LineBasicMaterial({
          color: color, transparent: true, opacity: opacity,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        var l = new THREE.LineSegments(g, m);
        group.add(l);
        return l;
      }
      linkLines = mkLines(linkPos, 0.17, 0x6FE0FF);
      tagLines = mkLines(tagPos, 0.035, 0xD9A93C);
      var indexLines = mkLines(indexPos, 0.018, 0x8FA3BF);   // 索引页边：几乎不可见，只留极淡的空间感
      api._indexLines = indexLines;

      /* 拾取代理：不可见小 mesh（material.visible=false，不产生 draw call） */
      var pickGeo = new THREE.SphereGeometry(1, 6, 4);
      var pickMat = new THREE.MeshBasicMaterial({ visible: false });
      nodes.forEach(function (nd, i) {
        var m = new THREE.Mesh(pickGeo, pickMat);
        m.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        m.userData.pickKind = 'note';
        m.userData.pickId = nd.id;
        m.userData.nodeIndex = i;
        group.add(m);
        pickMeshes.push(m);
      });

      /* 悬停环 */
      hoverRing = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.02, 4, 48),
        new THREE.MeshBasicMaterial({ color: 0x91DFFF, transparent: true, opacity: 0, blending: THREE.AdditiveBlending })
      );
      group.add(hoverRing);
    }

    /* ---------------- API ---------------- */
    var api = {
      group: group,
      get pickables() { return pickMeshes; },
      get nodes() { return nodes; },

      load: function (graph) { build(graph); return api; },

      setHover: function (nodeId) {
        var i = nodeId != null ? nodeIndex.get(nodeId) : -1;
        hovered = i == null ? -1 : i;
      },

      select: function (nodeId) {
        var i = nodeId != null ? nodeIndex.get(nodeId) : -1;
        selected = i == null ? -1 : i;
        if (selected >= 0) api.setHover(nodeId);
      },

      getNode: function (nodeId) {
        var i = nodeIndex.get(nodeId);
        return i == null ? null : nodes[i];
      },

      focusNode: function (nodeId) {
        var i = nodeIndex.get(nodeId);
        if (i == null) return null;
        return new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      },

      setVisible: function (v) { group.visible = v; },
      setQuality: function (q) {
        if (tagLines) tagLines.visible = q !== 'low';
        if (points) points.material.uniforms.uPixel.value = q === 'low' ? 0.75 : 1.0;
      },

      update: function (dt, t) {
        if (!group.visible) return;
        if (points) points.material.uniforms.uTime.value = t;

        /* 悬停环跟随 */
        if (hoverRing && positions) {
          if (hovered >= 0 && hovered < nodes.length) {
            var r = radii[hovered] || 1;
            hoverRing.position.set(positions[hovered * 3], positions[hovered * 3 + 1], positions[hovered * 3 + 2]);
            hoverRing.scale.setScalar(r * 1.5);
            hoverRing.lookAt(PAO.engine.camera.position);
            hoverRing.material.opacity = selected === hovered ? 0.85 : 0.5;
            hoverRing.visible = true;
          } else {
            hoverRing.visible = false;
          }
        }

        group.rotation.y += dt * 0.006;
      }
    };

    return api;
  };
})(window.PAO = window.PAO || {});
