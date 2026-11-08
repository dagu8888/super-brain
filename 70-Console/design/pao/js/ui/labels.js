/* PERSONAL AI OS — 空间标签层：3D 坐标投影为 DOM 标签 */
(function (PAO) {
  'use strict';

  var labels = {
    root: null,
    map: {},
    visible: true,
    _v: null,

    init: function (root) {
      labels.root = root;
      labels._v = new THREE.Vector3();
      return labels;
    },

    setVisible: function (v) {
      labels.visible = v;
      if (labels.root) labels.root.style.display = v ? '' : 'none';
    },

    update: function () {
      if (!labels.root || !labels.visible || !PAO.scene.ready) return;
      var targets = PAO.scene.labelTargets();
      var cam = PAO.engine.camera;
      var w = PAO.engine.width, h = PAO.engine.height;
      var seen = {};
      var appEl = document.getElementById('pao-app');
      labels._panelOpen = !!(appEl && appEl.classList.contains('is-panel-open'));

      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        seen[t.id] = true;
        var node = labels.map[t.id];
        if (!node) {
          node = labels._create(t);
          labels.map[t.id] = node;
          labels.root.appendChild(node.el);
        }

        var v = labels._v.copy(t.pos);
        v.project(cam);

        var behind = v.z > 1;
        var x = (v.x * 0.5 + 0.5) * w;
        var y = (-v.y * 0.5 + 0.5) * h;

        // 安全区：避开左导航 / 顶栏 / 底栏 / 右侧面板
        var safeL = 122, safeT = 72, safeB = h - 54, safeR = labels._panelOpen ? w - 452 : w - 26;

        var halfW = (node.el.offsetWidth || 110) / 2 + 6;
        var halfH = (node.el.offsetHeight || 56) / 2 + 4;

        if (behind || x - halfW < safeL || x + halfW > safeR || y - halfH < safeT || y + halfH > safeB) {
          node.el.style.opacity = '0';
          node.el.style.pointerEvents = 'none';
          continue;
        }

        var dist = cam.position.distanceTo(t.pos);
        var op = Math.max(0.62, Math.min(1, 1 - (dist - 9) / 30));
        // 聚焦某模块时，该模块自身标签淡出（对象已在画面中心）
        var activeId = PAO.bus && PAO.bus.store ? PAO.bus.store.activeModule : null;
        if (activeId && t.id === activeId && PAO.scene.mode === 'universe') op *= 0.18;
        node.el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) translate(-50%,-50%)';
        node.el.style.opacity = String(op);
        node.el.style.pointerEvents = 'auto';

        // 智能体标签：实时同步状态文案与状态色
        if (t.kind === 'agent' && node.stateEl) {
          var txt = t.statusZh || '未知';
          if (node.stateEl.textContent !== txt) node.stateEl.textContent = txt;
          if (t.hex) {
            if (node.dotEl && node.dotEl.style.background !== t.hex) node.dotEl.style.background = t.hex;
            if (node.stateEl.style.color !== t.hex) node.stateEl.style.color = t.hex;
          }
        }
      }

      for (var id in labels.map) {
        if (!seen[id]) labels.map[id].el.style.opacity = '0';
      }
    },

    _create: function (t) {
      var d = PAO.dom;
      var numText = t.kind === 'agent' ? (t.num || '') : (t.num + (t.kind === 'arch' ? '' : ' / 06'));
      var kids = [];
      var dotEl = null;
      if (t.kind === 'agent' && t.hex) {
        dotEl = d.el('i', { className: 'pao-label__dot' });
        dotEl.style.background = t.hex;
        kids.push(dotEl);
      }
      kids.push(d.el('span', { className: 'pao-label__num', text: numText }));
      kids.push(d.el('span', { className: 'pao-label__name', text: t.name }));
      kids.push(d.el('span', { className: 'pao-label__zh', text: t.zh }));
      var stateEl = null;
      if (t.kind === 'agent') {
        stateEl = d.el('span', { className: 'pao-label__num', text: t.statusZh || '' });
        stateEl.style.color = t.hex || 'var(--text-3)';
        stateEl.style.letterSpacing = '0';
        kids.push(stateEl);
      }

      var el = d.el('button', {
        className: 'pao-label pao-label--' + t.kind,
        attrs: { type: 'button' },
        dataset: { id: t.id }
      }, kids);

      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (t.kind === 'arch') PAO.ui.go('architecture');
        else if (t.kind === 'agent') PAO.bus.emit('agent:selected', { agentId: t.id });
        else PAO.ui.go(t.id);
      });
      el.addEventListener('pointerenter', function () {
        if (PAO.scene.mode === 'universe' && t.kind === 'module') PAO.scene.modules.setHover(t.id);
      });
      el.addEventListener('pointerleave', function () {
        if (PAO.scene.mode === 'universe' && t.kind === 'module') PAO.scene.modules.setHover(null);
      });

      return { el: el, target: t, stateEl: stateEl, dotEl: dotEl };
    },

    clear: function () {
      for (var id in labels.map) {
        if (labels.map[id].el.parentNode) labels.map[id].el.parentNode.removeChild(labels.map[id].el);
      }
      labels.map = {};
    }
  };

  PAO.labels = labels;
})(window.PAO = window.PAO || {});
