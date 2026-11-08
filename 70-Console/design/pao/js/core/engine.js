/* PERSONAL AI OS — 渲染引擎：renderer / scene / camera / loop / 性能守卫 */
(function (PAO) {
  'use strict';

  var engine = {
    renderer: null,
    scene: null,
    camera: null,
    canvas: null,
    clock: null,
    running: false,
    quality: 'high',           // 'high' | 'low'
    pixelRatio: 1,
    width: 0,
    height: 0,
    frame: 0,
    fps: 60,
    _samples: [],
    _lastT: 0,
    _onFrame: [],
    _degradedAt: 0
  };

  engine.init = function (canvas) {
    engine.canvas = canvas;

    engine.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: window.devicePixelRatio < 2,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false
    });
    engine.renderer.setClearColor(0x05070b, 1);
    if (engine.renderer.outputEncoding !== undefined) engine.renderer.outputEncoding = THREE.sRGBEncoding;
    if (engine.renderer.toneMapping !== undefined) {
      engine.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      engine.renderer.toneMappingExposure = 1.05;
    }

    engine.scene = new THREE.Scene();
    engine.scene.fog = new THREE.FogExp2(0x05070b, 0.014);

    engine.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 260);
    engine.camera.position.set(0, 3.2, 15);

    engine.clock = new THREE.Clock();

    engine.resize();
    window.addEventListener('resize', engine.resize, { passive: true });
    return engine;
  };

  engine.resize = function () {
    if (!engine.renderer) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    engine.width = w;
    engine.height = h;

    var dpr = window.devicePixelRatio || 1;
    var cap = engine.quality === 'low' ? 1.25 : 1.9;
    engine.pixelRatio = Math.min(dpr, cap);

    engine.renderer.setPixelRatio(engine.pixelRatio);
    engine.renderer.setSize(w, h, false);
    engine.camera.aspect = w / h;

    // 窄屏时扩大 FOV，避免模块被裁切
    engine.camera.fov = w / h < 1.15 ? 62 : 46;
    engine.camera.updateProjectionMatrix();

    if (engine.onResize) engine.onResize(w, h);
  };

  engine.onFrame = function (fn) { engine._onFrame.push(fn); };

  engine.start = function () {
    if (engine.running) return;
    engine.running = true;
    engine._lastT = performance.now();

    function loop(now) {
      if (!engine.running) return;
      requestAnimationFrame(loop);

      var dt = Math.min((now - engine._lastT) / 1000, 0.05);
      engine._lastT = now;
      engine.frame++;
      engine.tick(dt, now / 1000);
      engine.renderer.render(engine.scene, engine.camera);
    }
    requestAnimationFrame(loop);
  };

  engine.tick = function (dt, t) {
    for (var i = 0; i < engine._onFrame.length; i++) {
      try { engine._onFrame[i](dt, t); } catch (e) { /* 单个层出错不拖垮主循环 */ }
    }
    engine._watchPerf(dt);
  };

  engine._watchPerf = function (dt) {
    if (dt <= 0) return;
    engine._samples.push(dt);
    if (engine._samples.length > 90) engine._samples.shift();
    if (engine._samples.length < 60) return;

    var sum = 0;
    for (var i = 0; i < engine._samples.length; i++) sum += engine._samples[i];
    var avg = sum / engine._samples.length;
    engine.fps = Math.round(1 / avg);

    // 连续低于 42fps 且未降级过 → 降级
    if (engine.fps < 42 && engine.quality !== 'low' && performance.now() - engine._degradedAt > 12000) {
      engine._degradedAt = performance.now();
      engine.setQuality('low');
      if (PAO.bus) {
        PAO.bus.emit('perf:low', { fps: engine.fps });
        PAO.bus.set({ quality: 'low' });
        PAO.bus.emit('toast', { kind: 'warn', title: '已切换节能渲染', text: '检测到帧率偏低，已自动降低粒子与特效密度。' });
      }
    }
  };

  engine.setQuality = function (q) {
    engine.quality = q;
    engine.resize();
    var sc = engine.scene;
    if (sc && sc.fog) sc.fog.density = q === 'low' ? 0.02 : 0.014;
    if (PAO.scene && PAO.scene.applyQuality) PAO.scene.applyQuality(q);
  };

  engine.stop = function () { engine.running = false; };

  // 常用缓动
  engine.ease = {
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    outQuint: function (t) { return 1 - Math.pow(1 - t, 5); },
    inOutQuint: function (t) { return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2; }
  };

  PAO.engine = engine;
})(window.PAO = window.PAO || {});
