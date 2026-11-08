/* PERSONAL AI OS — 电影级启动序列（真实 3D 驱动） */
(function (PAO) {
  'use strict';

  var STAGES = [
    { p: 0.00, name: 'VOID', zh: '静默', hint: '正在唤醒个人智能核心…' },
    { p: 0.10, name: 'AWAKENING', zh: '唤醒', hint: '粒子正在向中心汇聚' },
    { p: 0.30, name: 'SYNCHRONIZATION', zh: '同步', hint: '正在建立精密轨道与数据通路' },
    { p: 0.46, name: 'SUMMON', zh: '显形', hint: '正在建立只读数据通道' },
    { p: 0.62, name: 'GREETING', zh: '问候', hint: '正在读取真实运行指标' },
    { p: 0.74, name: 'UNFOLD', zh: '展开', hint: '三维空间正在展开' },
    { p: 0.86, name: 'NETWORK', zh: '织网', hint: '智能体网络正在接入' },
    { p: 0.95, name: 'SYSTEM ONLINE', zh: '系统就绪', hint: 'Super-Brain 只读通道已就绪' }
  ];

  var GREETING = 'Super-Brain 只读通道已就绪。';

  var boot = {
    running: false,
    progress: 0,
    duration: 8600,
    _raf: 0,
    _start: 0,
    _skip: false,
    _nodes: {},

    init: function () {
      boot.root = document.getElementById('pao-boot');
      boot._nodes.bar = document.getElementById('pao-boot-bar');
      boot._nodes.stageName = document.getElementById('pao-boot-stage-name');
      boot._nodes.stageZh = document.getElementById('pao-boot-stage-zh');
      boot._nodes.hint = document.getElementById('pao-boot-hint');
      boot._nodes.skip = document.getElementById('pao-boot-skip');
      boot._nodes.online = document.getElementById('pao-boot-online');
      boot._nodes.brand = boot.root ? boot.root.querySelector('.pao-boot__brand') : null;
      boot._nodes.progress = boot.root ? boot.root.querySelector('.pao-boot__progress') : null;

      if (boot._nodes.skip) {
        boot._nodes.skip.addEventListener('click', function () { boot.skip(); });
      }

      // 数字人（启动第 4–5 幕）：程序化全息胸像，直接放进主场景
      if (PAO.buildHuman && PAO.engine && PAO.engine.scene) {
        try {
          boot.human = PAO.buildHuman({ scale: 1.4, detailed: true });
          boot.human.group.position.set(0, -1.25, 8);
          boot.human.setOpacity(0);
          boot.human.setVisible(false);
          PAO.engine.scene.add(boot.human.group);
          PAO.scene.human = boot.human;
        } catch (e) { console.warn('[boot] 数字人构建失败', e); boot.human = null; }
      }
      if (boot.root && !boot.root.querySelector('.pao-boot__greet')) {
        var g = document.createElement('div');
        g.className = 'pao-boot__greet';
        boot.root.appendChild(g);
        boot._nodes.greet = g;
      }
      return boot;
    },

    run: function (force) {
      if (!boot.root) boot.init();
      if (!boot.root) return;

      var seen = false;
      try { seen = localStorage.getItem('pao_intro_seen') === '1'; } catch (e) { seen = false; }

      boot.duration = (force || !seen) ? 8600 : 1500;
      boot._skip = false;
      boot.progress = 0;
      boot._start = performance.now();

      boot.root.classList.remove('is-done');
      boot.root.classList.add('is-active');
      if (boot.human) { boot.human.setVisible(false); boot.human.setOpacity(0); boot.human.setState('idle'); boot._greeted = false; }
      if (boot._nodes.greet) { boot._nodes.greet.textContent = ''; boot._nodes.greet.classList.remove('is-in'); }
      PAO.scene.setBootProgress(0);

      // 启动时先隐藏 HUD
      document.body.classList.add('pao-booting');

      boot._tick();
      boot.running = true;
    },

    skip: function () {
      boot._skip = true;
    },

    _tick: function () {
      var now = performance.now();
      var k = Math.min(1, (now - boot._start) / boot.duration);

      // 缓入，让前半段更有仪式感
      var eased = boot._skip ? Math.min(1, boot.progress + 0.06) : (k < 0.82 ? k * 1.0 : 0.82 + (k - 0.82) * 1.0);

      boot.progress = Math.max(boot.progress, eased * (boot._skip ? 1 : 1));
      if (boot._skip) boot.progress += (1 - boot.progress) * 0.12;

      PAO.scene.setBootProgress(Math.min(1, boot.progress));
      boot._updateDom(boot.progress);

      if (boot.progress >= 0.999) {
        boot._finish();
        return;
      }
      boot._raf = requestAnimationFrame(boot._tick);
    },

    _updateDom: function (p) {
      if (boot._nodes.bar) boot._nodes.bar.style.transform = 'scaleX(' + p.toFixed(3) + ')';

      var stage = STAGES[0];
      for (var i = 0; i < STAGES.length; i++) if (p >= STAGES[i].p) stage = STAGES[i];

      if (boot._nodes.stageName && boot._nodes.stageName.textContent !== stage.name) {
        boot._nodes.stageName.textContent = stage.name;
        boot._nodes.stageZh.textContent = stage.zh;
        boot._nodes.hint.textContent = stage.hint;
      }

      if (boot._nodes.brand) {
        var fadeIn = Math.min(1, p * 6);
        var fadeOut = p < 0.52 ? 1 : Math.max(0, 1 - (p - 0.52) / 0.10);
        boot._nodes.brand.style.opacity = String(fadeIn * fadeOut);
      }
      if (boot._nodes.progress) {
        boot._nodes.progress.style.opacity = String(Math.min(1, Math.max(0, (p - 0.04) * 8)) * (p > 0.9 ? 0.4 : 1));
      }
      if (boot._nodes.online) {
        var on = p > 0.90;
        boot._nodes.online.classList.toggle('is-in', on);
      }

      /* ---- 第 4 幕 SUMMON：淡入；第 5 幕 GREETING：问候；UNFOLD 起淡出 ---- */
      if (boot.human) {
        if (p >= 0.44 && p < 0.78) {
          boot.human.setVisible(true);
          var appear = Math.min(1, (p - 0.44) / 0.10);
          var leave = p <= 0.70 ? 1 : Math.max(0, (0.78 - p) / 0.08);
          boot.human.setOpacity(appear * leave * 0.95);
          if (p >= 0.60 && p < 0.70 && !boot._greeted) {
            boot._greeted = true;
            boot.human.setState('listening');
            setTimeout(function () {
              if (!boot.human) return;
              boot.human.setState('speaking');
              if (boot._nodes.greet) {
                boot._nodes.greet.textContent = GREETING;
                boot._nodes.greet.classList.add('is-in');
              }
              boot.human.speak(GREETING, function () { if (boot.human) boot.human.setState('idle'); });
            }, 260);
          }
          if (p >= 0.70) {
            if (boot._nodes.greet) boot._nodes.greet.classList.remove('is-in');
            boot.human.setState('waiting');
          }
        } else if (p >= 0.78) {
          boot.human.setOpacity(0);
          boot.human.setVisible(false);
        }
      }
    },

    _finish: function () {
      boot.running = false;
      cancelAnimationFrame(boot._raf);
      PAO.scene.setBootProgress(1);
      boot.root.classList.add('is-done');
      document.body.classList.remove('pao-booting');
      try { localStorage.setItem('pao_intro_seen', '1'); } catch (e) {}

      setTimeout(function () {
        boot.root.classList.remove('is-active', 'is-done');
        boot.root.style.display = 'none';
        if (boot._nodes.online) boot._nodes.online.classList.remove('is-in');
      }, 1000);

      if (boot.human) {
        boot.human.setVisible(false);
        boot.human.setOpacity(0);
        if (boot.human.group.parent) boot.human.group.parent.remove(boot.human.group);
      }
      PAO.bus.set({ booted: true });
      document.body.classList.add('pao-booted');
      PAO.bus.emit('boot:done', {});
      /* 只在仍处于默认视图时回正镜头；用户已切换视图则不打断 */
      if (PAO.scene.mode === 'universe' && PAO.rig) PAO.rig.home(900);
    }
  };

  PAO.boot = boot;
})(window.PAO = window.PAO || {});
