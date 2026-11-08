/* PERSONAL AI OS — 轻量 DOM 动效工具 */
(function (PAO) {
  'use strict';

  var fx = {
    reduce: false,

    setReduced: function (v) {
      fx.reduce = !!v;
      document.documentElement.classList.toggle('pao-reduce-motion', fx.reduce);
    },

    /* 数字滚动 */
    count: function (el, from, to, dur, fmt) {
      if (fx.reduce) { el.textContent = fmt ? fmt(to) : to; return; }
      var start = performance.now();
      dur = dur || 800;
      function step(now) {
        var k = Math.min(1, (now - start) / dur);
        var e = 1 - Math.pow(1 - k, 3);
        var v = from + (to - from) * e;
        el.textContent = fmt ? fmt(v) : Math.round(v);
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    },

    /* 打字机 */
    type: function (el, text, speed, done) {
      if (fx.reduce || !text) { el.textContent = text || ''; if (done) done(); return; }
      var i = 0;
      el.textContent = '';
      speed = speed || 18;
      var timer = setInterval(function () {
        i++;
        el.textContent = text.slice(0, i);
        if (i >= text.length) { clearInterval(timer); if (done) done(); }
      }, speed);
      return timer;
    },

    /* 依次淡入 */
    stagger: function (nodes, gap, cls) {
      cls = cls || 'is-in';
      if (fx.reduce) { nodes.forEach(function (n) { n.classList.add(cls); }); return; }
      nodes.forEach(function (n, i) {
        setTimeout(function () { n.classList.add(cls); }, i * (gap || 40));
      });
    },

    /* 元素脉冲 */
    pulse: function (el, cls) {
      el.classList.remove(cls || 'is-pulse');
      void el.offsetWidth;
      el.classList.add(cls || 'is-pulse');
      setTimeout(function () { el.classList.remove(cls || 'is-pulse'); }, 900);
    }
  };

  PAO.fx = fx;
})(window.PAO = window.PAO || {});
