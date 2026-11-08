/* PERSONAL AI OS — 应用入口 */
(function (PAO) {
  'use strict';

  var app = {
    started: false,

    init: function () {
      if (app.started) return;
      app.started = true;

      var canvas = document.getElementById('pao-canvas');
      if (!canvas) return;

      // WebGL 可用性检查
      try {
        var test = document.createElement('canvas');
        var gl = test.getContext('webgl') || test.getContext('experimental-webgl');
        if (!gl) throw new Error('WebGL unavailable');
      } catch (e) {
        app._fail('当前浏览器未启用 WebGL，无法渲染三维场景。请使用最新版 Chrome / Edge / Safari，或在设置中开启硬件加速。');
        return;
      }

      try {
        PAO.engine.init(canvas);
        PAO.scene.init();
        PAO.labels.init(document.getElementById('pao-labels'));
        PAO.ui.init();
        PAO.pointer.init(canvas);
        PAO.scene.applyQuality(PAO.engine.quality);
        PAO.engine.start();
      } catch (err) {
        console.error(err);
        app._fail('三维场景初始化失败：' + (err && err.message ? err.message : '未知错误'));
        return;
      }

      if (PAO.hovercard && PAO.hovercard.init) PAO.hovercard.init();

      // 连接后端事件总线（阳层实时状态 → 阴层三维节点）
      if (PAO.net && PAO.net.connect) PAO.net.connect();

      PAO.boot.init();
      PAO.boot.run(false);

      // 首帧后移除「加载中」态
      setTimeout(function () { document.body.classList.add('pao-ready'); }, 120);

      // 供自动化冒烟测试使用
      window.__PAO_READY__ = true;
      PAO.app = app;
    },

    _fail: function (msg) {
      var box = document.getElementById('pao-fallback');
      if (box) {
        box.style.display = 'flex';
        var t = box.querySelector('[data-msg]');
        if (t) t.textContent = msg;
      }
      console.warn('[PAO]', msg);
    }
  };

  PAO.app = app;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', app.init);
  } else {
    app.init();
  }
})(window.PAO = window.PAO || {});
