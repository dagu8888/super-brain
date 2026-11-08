/* PERSONAL AI OS — 指针交互：拖动旋转 / 滚轮缩放 / 拾取 / 悬停 */
(function (PAO) {
  'use strict';

  var pointer = {
    ndc: new THREE.Vector2(-10, -10),
    screenX: 0,
    screenY: 0,
    down: false,
    dragging: false,
    moved: 0,
    downX: 0,
    downY: 0,
    downT: 0,
    hovered: null,
    _raf: 0,
    _dirty: false,
    enabled: true,

    init: function (canvas) {
      pointer.canvas = canvas;

      canvas.addEventListener('pointerdown', pointer._onDown, { passive: false });
      window.addEventListener('pointermove', pointer._onMove, { passive: true });
      window.addEventListener('pointerup', pointer._onUp, { passive: true });
      canvas.addEventListener('pointerleave', function () {
        pointer.ndc.set(-10, -10);
        pointer._dirty = true;
      }, { passive: true });
      canvas.addEventListener('wheel', pointer._onWheel, { passive: false });
      canvas.addEventListener('dblclick', function (e) {
        e.preventDefault();
        if (PAO.scene) PAO.scene.handleDoubleClick();
      });
      canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    },

    _onDown: function (e) {
      if (!pointer.enabled) return;
      if (e.button !== 0) return;
      pointer.down = true;
      pointer.dragging = false;
      pointer.moved = 0;
      pointer.downX = e.clientX;
      pointer.downY = e.clientY;
      pointer.downT = performance.now();
      pointer.canvas.style.cursor = 'grabbing';
    },

    _onMove: function (e) {
      pointer.screenX = e.clientX;
      pointer.screenY = e.clientY;
      var r = pointer.canvas.getBoundingClientRect();
      pointer.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      pointer._dirty = true;

      if (!pointer.down) return;
      var dx = e.clientX - pointer.downX;
      var dy = e.clientY - pointer.downY;
      pointer.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);

      if (pointer.moved > 4) pointer.dragging = true;

      if (pointer.dragging) {
        PAO.rig.orbitDelta(e.movementX || dx * 0.6, e.movementY || dy * 0.6);
        pointer.downX = e.clientX;
        pointer.downY = e.clientY;
      }
    },

    _onUp: function (e) {
      if (!pointer.down) return;
      pointer.down = false;
      pointer.canvas.style.cursor = '';
      var dt = performance.now() - pointer.downT;

      if (!pointer.dragging && dt < 520) {
        pointer._click(e);
      }
      pointer.dragging = false;
      pointer.moved = 0;
      pointer._dirty = true;
    },

    _click: function () {
      var hit = pointer.pick();
      if (hit && PAO.scene) PAO.scene.handlePick(hit);
      else if (PAO.scene && PAO.scene.mode === 'universe') {
        // 点空白：轻微回正
        PAO.bus.emit('scene:blank');
      }
    },

    _onWheel: function (e) {
      if (!pointer.enabled) return;
      e.preventDefault();
      PAO.rig.zoom(e.deltaY);
    },

    /* 每帧最多执行一次拾取 */
    update: function () {
      if (!pointer._dirty) return;
      pointer._dirty = false;
      var hit = pointer.pick();
      if (!hit) hit = pointer.proximityPick();
      var id = hit ? hit.object.userData.pickId : null;
      if (id !== pointer.hovered) {
        pointer.hovered = id;
        if (PAO.scene) PAO.scene.handleHover(hit);
      }
      pointer.canvas.style.cursor = hit ? 'pointer' : '';
    },

    /* 屏幕空间就近命中：鼠标靠近节点即响应（比精确打中 3D 网格更符合直觉） */
    proximityPick: function () {
      if (!PAO.scene || !PAO.engine.camera) return null;
      var items = PAO.scene.getPickables();
      if (!items || !items.length) return null;

      var cam = PAO.engine.camera;
      var w = PAO.engine.width || window.innerWidth;
      var h = PAO.engine.height || window.innerHeight;
      var mx = (pointer.ndc.x * 0.5 + 0.5) * w;
      var my = (-pointer.ndc.y * 0.5 + 0.5) * h;

      pointer._v = pointer._v || new THREE.Vector3();
      var best = null, bestD = 46 * 46;   // 命中半径 46px

      for (var i = 0; i < items.length; i++) {
        var o = items[i];
        if (!o.visible) continue;
        var vis = true, p = o;
        while (p) { if (!p.visible) { vis = false; break; } p = p.parent; }
        if (!vis) continue;

        var v = pointer._v;
        o.getWorldPosition(v);
        v.project(cam);
        if (v.z > 1) continue;

        var sx = (v.x * 0.5 + 0.5) * w;
        var sy = (-v.y * 0.5 + 0.5) * h;
        var dx = sx - mx, dy = sy - my;
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = o; }
      }

      if (!best) return null;
      return {
        object: best, kind: best.userData.pickKind,
        pickId: best.userData.pickId, proximity: true,
        point: null, distance: 0
      };
    },

    pick: function () {
      if (!PAO.scene || !PAO.engine.camera) return null;
      var items = PAO.scene.getPickables();
      if (!items || !items.length) return null;
      pointer._raycaster = pointer._raycaster || new THREE.Raycaster();
      pointer._raycaster.setFromCamera(pointer.ndc, PAO.engine.camera);
      var hits = pointer._raycaster.intersectObjects(items, false);
      if (!hits.length) return null;

      // 取最近且可用（可见）的
      for (var i = 0; i < hits.length; i++) {
        var o = hits[i].object;
        if (!o.visible) continue;
        var p = o.parent;
        var visible = true;
        while (p) { if (!p.visible) { visible = false; break; } p = p.parent; }
        if (!visible) continue;
        return { object: o, point: hits[i].point, distance: hits[i].distance, kind: o.userData.pickKind, pickId: o.userData.pickId };
      }
      return null;
    }
  };

  PAO.pointer = pointer;
})(window.PAO = window.PAO || {});
