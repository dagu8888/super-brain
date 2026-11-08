/* PERSONAL AI OS — 三维记忆宇宙：簇 / 节点 / 关联线 / 检索高亮 */
(function (PAO) {
  'use strict';

  var CAT_STYLE = {
    FACTS: { color: 0x55ddf5, geo: 'octa', size: 0.30, zh: '事实' },
    EVENTS: { color: 0x9178ff, geo: 'icosa', size: 0.30, zh: '事件' },
    PREFERENCES: { color: 0x91dfff, geo: 'box', size: 0.26, zh: '偏好' },
    RELATIONSHIPS: { color: 0x5fd6c8, geo: 'tetra', size: 0.28, zh: '关系' },
    GOALS: { color: 0x4f8fe0, geo: 'dodeca', size: 0.32, zh: '目标' },
    DECISIONS: { color: 0xa9c6ff, geo: 'sphere', size: 0.27, zh: '决策' }
  };

  function geoFor(kind, size) {
    switch (kind) {
      case 'octa': return new THREE.OctahedronGeometry(size, 0);
      case 'icosa': return new THREE.IcosahedronGeometry(size, 0);
      case 'box': return new THREE.BoxGeometry(size * 1.5, size * 1.5, size * 1.5);
      case 'tetra': return new THREE.TetrahedronGeometry(size * 1.25, 0);
      case 'dodeca': return new THREE.DodecahedronGeometry(size, 0);
      case 'sphere': return new THREE.SphereGeometry(size, 12, 10);
      default: return new THREE.IcosahedronGeometry(size, 0);
    }
  }

  PAO.buildMemory = function (data) {
    var group = new THREE.Group();
    group.name = 'memory-universe';
    group.visible = false;

    var nodes = {};       // id -> { mesh, def, cluster, basePos }
    var nodeList = [];
    var pickables = [];
    var clusterGroups = {};

    /* ---------- 记忆簇：空间锚点 + 极淡的簇界 ---------- */
    var clusters = data.memoryClusters || [];
    clusters.forEach(function (cl, i) {
      var c = cl.center || [Math.cos(i) * 7, 0, Math.sin(i) * 7];
      var center = new THREE.Vector3(c[0], c[1], c[2]);

      var shellGeo = new THREE.SphereGeometry(2.15, 14, 10);
      var shellMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(cl.color || 0x2a7a9a),
        wireframe: true, transparent: true, opacity: 0.06,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var shell = new THREE.Mesh(shellGeo, shellMat);
      shell.position.copy(center);
      group.add(shell);

      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.3, 0.006, 4, 64),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(cl.color || 0x2a7a9a), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending })
      );
      ring.position.copy(center);
      ring.rotation.x = Math.PI / 2 + (i % 2 ? 0.3 : -0.2);
      group.add(ring);

      clusterGroups[cl.name] = { center: center, shell: shell, ring: ring, def: cl, nodeCount: 0 };
    });

    /* ---------- 节点 ---------- */
    var geos = {};
    Object.keys(CAT_STYLE).forEach(function (k) {
      geos[k] = geoFor(CAT_STYLE[k].geo, CAT_STYLE[k].size);
    });

    (data.memories || []).forEach(function (m, idx) {
      var style = CAT_STYLE[m.category] || CAT_STYLE.FACTS;
      var cg = clusterGroups[m.cluster];
      if (!cg) {
        var fallbackKey = Object.keys(clusterGroups)[idx % Math.max(1, Object.keys(clusterGroups).length)];
        cg = clusterGroups[fallbackKey];
      }
      var base = cg ? cg.center.clone() : new THREE.Vector3(0, 0, 0);
      var golden = 2.399963;
      var r = 0.5 + Math.pow((idx % 13) / 13, 0.65) * 1.85;
      var ph = Math.acos(1 - 2 * ((idx % 17) + 0.5) / 17);
      var th = golden * idx;
      var pos = new THREE.Vector3(
        base.x + Math.sin(ph) * Math.cos(th) * r,
        base.y + Math.cos(ph) * r * 0.85,
        base.z + Math.sin(ph) * Math.sin(th) * r
      );
      if (cg) cg.nodeCount++;

      var mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(style.color),
        transparent: true,
        opacity: m.validity === 'STALE' ? 0.32 : 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });

      var mesh = new THREE.Mesh(geos[m.category] || geos.FACTS, mat);
      mesh.position.copy(pos);
      mesh.userData.pickKind = 'memory';
      mesh.userData.pickId = m.id;
      mesh.userData.baseScale = 1.05 + (m.weight || 0.5) * 0.85;
      mesh.scale.setScalar(1);
      group.add(mesh);
      pickables.push(mesh);

      var rec = {
        id: m.id, def: m, mesh: mesh, mat: mat,
        base: pos.clone(), cluster: cg,
        phase: idx * 0.37, hover: 0, sel: 0
      };
      nodes[m.id] = rec;
      nodeList.push(rec);
    });

    /* ---------- 关联线 ---------- */
    var linkPositions = [];
    var linkColors = [];
    var seen = {};
    (data.memories || []).forEach(function (m) {
      (m.links || []).forEach(function (toId) {
        var key = m.id < toId ? m.id + '|' + toId : toId + '|' + m.id;
        if (seen[key]) return;
        seen[key] = true;
        var a = nodes[m.id], b = nodes[toId];
        if (!a || !b) return;
        linkPositions.push(a.base.x, a.base.y, a.base.z, b.base.x, b.base.y, b.base.z);
        var col = new THREE.Color((CAT_STYLE[m.category] || CAT_STYLE.FACTS).color);
        linkColors.push(col.r * 0.34, col.g * 0.34, col.b * 0.34, col.r * 0.10, col.g * 0.10, col.b * 0.10);
      });
    });
    var linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.Float32BufferAttribute(linkPositions, 3));
    linkGeo.setAttribute('color', new THREE.Float32BufferAttribute(linkColors, 3));
    var linkMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var links = new THREE.LineSegments(linkGeo, linkMat);
    group.add(links);

    /* ---------- 选中指示环 ---------- */
    var selector = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.012, 4, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending })
    );
    selector.visible = false;
    group.add(selector);

    var selectedId = null;
    var filterCat = 'ALL';
    var emerge = 0;

    var api = {
      group: group,
      pickables: pickables,
      getNode: function (id) { return nodes[id]; },

      select: function (id) {
        selectedId = id;
        var rec = nodes[id];
        if (!rec) { selector.visible = false; return; }
        selector.visible = true;
        selector.position.copy(rec.mesh.position);
        selector.material.color.set((CAT_STYLE[rec.def.category] || CAT_STYLE.FACTS).color);
        return rec;
      },

      getSelected: function () { return selectedId; },

      setFilter: function (cat) {
        filterCat = cat || 'ALL';
      },

      setQuality: function (q) {
        linkMat.opacity = q === 'low' ? 0.35 : 0.55;
        Object.keys(clusterGroups).forEach(function (k) {
          clusterGroups[k].shell.visible = q !== 'low';
        });
      },

      setVisible: function (v) {
        group.visible = v;
      },

      setProgress: function (p) {
        emerge = p;
      },

      update: function (dt, t) {
        if (!group.visible) return;

        var grow = Math.min(1, emerge);

        nodeList.forEach(function (rec) {
          var isFiltered = filterCat !== 'ALL' && rec.def.category !== filterCat;
          var isSel = selectedId === rec.id;
          var targetOp = isSel ? 1 : (isFiltered ? 0.10 : (filterCat !== 'ALL' ? 0.95 : 0.78));
          if (rec.def.validity === 'STALE') targetOp *= 0.55;

          rec.mat.opacity += (targetOp - rec.mat.opacity) * 0.12;
          var s = (rec.mesh.userData.baseScale) * (0.35 + 0.65 * grow) * (isSel ? 1.9 : (isFiltered ? 0.7 : 1));
          rec.mesh.scale.setScalar(s + Math.sin(t * 1.2 + rec.phase) * 0.03);
          rec.mesh.rotation.y += dt * 0.25;
          rec.mesh.rotation.x += dt * 0.1;
        });

        if (selector.visible) {
          var rec2 = nodes[selectedId];
          if (rec2) {
            selector.position.lerp(rec2.mesh.position, 0.18);
            selector.lookAt(PAO.engine.camera.position);
            selector.rotation.z += dt * 0.8;
            selector.material.opacity = 0.55 + Math.sin(t * 3) * 0.2;
          }
        }

        linkMat.opacity = (filterCat === 'ALL' ? 0.5 : 0.22) * grow;
        group.rotation.y += dt * 0.012;
      }
    };

    return api;
  };
})(window.PAO = window.PAO || {});
