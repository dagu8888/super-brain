/* PERSONAL AI OS · GUIDED EXPERIENCE（引导体验）
   js/ui/panels/guided.js ｜ 契约：CONTRACT §4/§5/§6/§13、DATA.guided
   · 8 幕：进度点阵可跳幕 / 上一幕 / 下一幕 / 重新开始 / 退出引导
   · 切幕 emit guided:stage + scene.setGuidedStage；不自动切换面板
   · 自动播放每 12 秒进一幕，退出面板自动关闭
   · 全部文案中文，颜色只用 CSS 变量 */
(function (PAO) {
  'use strict';

  var DOM = null;
  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  var FOCUS_ZH = {
    core: '核心',
    memory: '记忆系统',
    cognitive: '认知引擎',
    agent: '智能体运行时',
    data: '数据宇宙',
    model: '模型网关',
    trust: '权限与信任',
    architecture: '系统架构'
  };
  var AUTO_MS = 12000;   // 自动播放间隔：12 秒

  var G = freshState();

  function freshState() {
    return {
      ctx: null,
      data: null,
      stages: [],
      modules: {},
      index: 0,
      auto: false,
      timer: null,
      remainSec: AUTO_MS / 1000,
      countdown: null,
      keyHandler: null,
      nodes: {},
      dots: []
    };
  }

  /* ---------------------------------------------------------------- 小工具 */
  function el(tag, props, kids) { return DOM.el(tag, props, kids); }

  function pad2(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return v < 10 ? '0' + v : String(v);
  }

  function roman(i) { return ROMAN[i] || String(i + 1); }

  function emit(evt, payload) {
    var bus = (G.ctx && G.ctx.bus) || PAO.bus;
    if (bus && typeof bus.emit === 'function') bus.emit(evt, payload);
  }

  function toast(kind, title, text) {
    var ui = (G.ctx && G.ctx.ui) || PAO.ui;
    if (ui && typeof ui.toast === 'function') ui.toast(kind, title, text);
  }

  function go(id) {
    if (!G.ctx || typeof G.ctx.go !== 'function') return;
    G.ctx.go(id);
  }

  function focusLabel(id) {
    if (G.modules[id]) return G.modules[id];
    if (FOCUS_ZH[id]) return FOCUS_ZH[id];
    return String(id || '核心');
  }

  function btn(label, act, kind, index) {
    var node = el('button', {
      className: 'pao-btn' + (kind ? ' pao-btn--' + kind : ''),
      dataset: { gact: act },
      type: 'button'
    });
    if (index != null) node.setAttribute('data-index', String(index));
    node.textContent = label;
    return node;
  }

  /* ---------------------------------------------------------------- 数据层 */
  function prepare(ctx) {
    var data = ctx.data || PAO.DATA || {};
    G.data = data;
    G.stages = data.guided || [];
    var mods = data.modules || [];
    G.modules = {};
    for (var i = 0; i < mods.length; i++) {
      if (mods[i] && mods[i].id) G.modules[mods[i].id] = mods[i].zh || mods[i].name || mods[i].id;
    }
    G.index = 0;
    G.auto = false;
  }

  /* -------------------------------------------------------------- 面板构建 */
  function render(root, ctx) {
    unbindKeys();
    clearAuto();
    G = freshState();
    G.ctx = ctx;
    DOM = ctx.dom || PAO.dom;
    prepare(ctx);

    var wrap = el('div', { className: 'pao-guided' });
    wrap.appendChild(buildBanner());
    wrap.appendChild(buildProgress());
    wrap.appendChild(buildStageSection());
    wrap.appendChild(buildControls());
    wrap.appendChild(buildActList());
    wrap.appendChild(buildFooter());
    root.appendChild(wrap);
    G.nodes.wrap = wrap;

    bindDelegates(wrap);
    bindKeys();

    if (!G.stages.length) {
      renderEmpty();
      return;
    }
    goStage(0);
  }

  function buildBanner() {
    var box = el('div', { className: 'pao-guided__banner' });
    box.appendChild(el('span', { className: 'pao-tag', text: '引导模式' }));
    box.appendChild(el('p', {
      className: 'pao-guided__banner-text',
      text: '引导模式不会限制你自由探索，随时可以点击任意模块离开。'
    }));
    return box;
  }

  function buildProgress() {
    var sec = el('section', { className: 'pao-section' });
    var head = el('div', { className: 'pao-section__head' });
    head.appendChild(el('h3', { className: 'pao-section__title', text: '八幕进程' }));
    head.appendChild(el('p', {
      className: 'pao-section__hint',
      text: '点击任意进度点可直接跳到该幕，不会离开本面板。'
    }));
    sec.appendChild(head);

    var dots = el('div', { className: 'pao-guided__dots' });
    G.dots = [];
    for (var i = 0; i < G.stages.length; i++) {
      var stage = G.stages[i] || {};
      var dot = el('button', {
        className: 'pao-dot',
        dataset: { gact: 'jump' },
        type: 'button',
        title: '第 ' + (i + 1) + ' 幕 · ' + (stage.title || '')
      });
      dot.setAttribute('data-index', String(i));
      dot.setAttribute('aria-label', '跳到第 ' + (i + 1) + ' 幕');
      dot.appendChild(el('span', { className: 'pao-dot__num pao-mono', text: pad2(i + 1) }));
      dot.appendChild(el('span', { className: 'pao-dot__label', text: 'ACT ' + roman(i) }));
      dots.appendChild(dot);
      G.dots.push(dot);
    }
    sec.appendChild(dots);

    var metaRow = el('div', { className: 'pao-guided__progress-meta' });
    var count = el('span', { className: 'pao-guided__count', text: '第 1 / ' + Math.max(1, G.stages.length) + ' 幕' });
    metaRow.appendChild(count);
    G.nodes.count = count;

    var sw = el('button', {
      className: 'pao-switch' + (G.auto ? ' is-on' : ''),
      dataset: { gact: 'auto' },
      type: 'button',
      role: 'switch'
    });
    sw.setAttribute('aria-checked', G.auto ? 'true' : 'false');
    var track = el('span', { className: 'pao-switch__track' });
    track.appendChild(el('span', { className: 'pao-switch__knob' }));
    sw.appendChild(track);
    sw.appendChild(el('span', { className: 'pao-switch__label', text: '自动播放 · 12 秒' }));
    metaRow.appendChild(sw);
    G.nodes.switch = sw;

    var autoHint = el('span', { className: 'pao-guided__auto-hint', text: '自动播放已关闭' });
    metaRow.appendChild(autoHint);
    G.nodes.autoHint = autoHint;
    sec.appendChild(metaRow);

    return sec;
  }

  function buildStageSection() {
    var sec = el('section', { className: 'pao-section' });
    var head = el('div', { className: 'pao-section__head' });
    head.appendChild(el('h3', { className: 'pao-section__title', text: '当前幕' }));
    head.appendChild(el('p', {
      className: 'pao-section__hint',
      text: '八幕依次说明个人智能系统的每一层，切换只改变场景聚焦。'
    }));
    sec.appendChild(head);
    var stage = el('div', { className: 'pao-guided__stage' });
    sec.appendChild(stage);
    G.nodes.stage = stage;
    return sec;
  }

  function buildControls() {
    var sec = el('section', { className: 'pao-section' });
    var row = el('div', { className: 'pao-guided__controls' });
    var prev = btn('上一幕', 'prev', 'ghost');
    var next = btn('下一幕', 'next', 'primary');
    var restart = btn('重新开始', 'restart', 'ghost');
    var exit = btn('退出引导', 'exit', 'ghost');
    row.appendChild(prev); row.appendChild(next); row.appendChild(restart); row.appendChild(exit);
    sec.appendChild(row);
    G.nodes.prev = prev;
    G.nodes.next = next;
    G.nodes.restart = restart;
    G.nodes.exit = exit;
    return sec;
  }

  function buildFooter() {
    var f = el('div', { className: 'pao-guided__footer' });
    f.appendChild(el('span', { className: 'pao-tag', text: '引导剧本' }));
    f.appendChild(el('span', {
      className: 'pao-guided__footer-text',
      text: '共 ' + Math.max(0, G.stages.length) + ' 幕 · 约 3 分钟 · 产品引导剧本'
    }));
    return f;
  }

  /* -------------------------------------------------------------- 幕内容 */
  function renderStage() {
    var box = G.nodes.stage;
    if (!box) return;
    DOM.clear(box);

    var stage = G.stages[G.index];
    if (!stage) {
      box.appendChild(el('div', { className: 'pao-empty', text: '该幕暂无内容。' }));
      return;
    }

    var kicker = el('div', { className: 'pao-guided__kicker' });
    kicker.appendChild(el('span', { className: 'pao-tag', text: 'ACT ' + roman(G.index) }));
    kicker.appendChild(el('span', { className: 'pao-mono pao-guided__count-small', text: 'STAGE ' + pad2(G.index + 1) + ' / ' + pad2(G.stages.length) }));
    box.appendChild(kicker);

    var meter = el('div', { className: 'pao-meter pao-guided__meter' });
    var fill = el('span', { className: 'pao-meter__fill' });
    fill.style.transform = 'scaleX(' + ((G.index + 1) / G.stages.length) + ')';
    meter.appendChild(fill);
    box.appendChild(meter);

    box.appendChild(el('h4', { className: 'pao-guided__title', text: stage.title || '未命名一幕' }));
    if (stage.titleEn) {
      box.appendChild(el('p', { className: 'pao-guided__title-en pao-mono', text: stage.titleEn }));
    }

    var text = el('p', { className: 'pao-guided__text', text: stage.text || '' });
    box.appendChild(text);

    var highlights = stage.highlight || [];
    if (highlights.length) {
      var tags = el('div', { className: 'pao-guided__tags' });
      tags.appendChild(el('span', { className: 'pao-guided__tags-label', text: '本幕要点' }));
      for (var i = 0; i < highlights.length; i++) {
        tags.appendChild(el('span', { className: 'pao-tag', text: String(highlights[i]) }));
      }
      box.appendChild(tags);
    }

    if (stage.caption) {
      box.appendChild(el('p', { className: 'pao-guided__caption', text: stage.caption }));
    }

    var focus = stage.focus || 'core';
    var focusBox = el('div', { className: 'pao-guided__focus' });
    focusBox.appendChild(el('span', { className: 'pao-tag', text: '场景聚焦' }));
    focusBox.appendChild(el('span', {
      className: 'pao-guided__focus-text',
      text: focus === 'core'
        ? '场景已回到核心 · 面板保持不变'
        : '场景已聚焦：' + focusLabel(focus) + ' · 面板不会自动切换'
    }));
    box.appendChild(focusBox);

    var moduleCard = buildModuleCard(stage);
    if (moduleCard) box.appendChild(moduleCard);

    if (G.index >= G.stages.length - 1) box.appendChild(buildEndBlock());
  }

  function buildEndBlock() {
    var box = el('div', { className: 'pao-guided__end' });
    box.appendChild(el('span', { className: 'pao-tag', text: '引导结束' }));
    box.appendChild(el('p', {
      className: 'pao-guided__end-text',
      text: '八幕已全部走完。你可以回到总览，或直接查看系统架构。'
    }));
    var actions = el('div', { className: 'pao-guided__end-actions' });
    actions.appendChild(btn('回到总览', 'home', 'primary'));
    actions.appendChild(btn('查看架构', 'arch', 'ghost'));
    box.appendChild(actions);
    return box;
  }

  function renderEmpty() {
    var box = G.nodes.stage;
    if (box) box.appendChild(el('div', { className: 'pao-empty', text: '引导数据未加载 · 等待 data.guided 接入' }));
    if (G.nodes.prev) G.nodes.prev.disabled = true;
    if (G.nodes.next) G.nodes.next.disabled = true;
    if (G.nodes.restart) G.nodes.restart.disabled = true;
    if (G.nodes.count) G.nodes.count.textContent = '第 0 / 0 幕';
  }

  /* -------------------------------------------------------------- 切幕逻辑 */
  function goStage(i) {
    if (!G.stages.length) return;
    var idx = Math.max(0, Math.min(G.stages.length - 1, i));
    G.index = idx;

    emit('guided:stage', { index: idx });
    setSceneStage(idx);

    renderStage();
    updateDots();
    updateActList();
    updateControls();
    updateCount();
    scheduleAuto();
  }

  function setSceneStage(i) {
    var scene = (G.ctx && G.ctx.scene) || PAO.scene;
    if (scene && typeof scene.setGuidedStage === 'function') scene.setGuidedStage(i);
  }

  function updateDots() {
    for (var i = 0; i < G.dots.length; i++) {
      var cls = 'pao-dot';
      if (i === G.index) cls += ' is-active';
      else if (i < G.index) cls += ' is-done';
      G.dots[i].className = cls;
    }
  }

  function updateControls() {
    var last = G.stages.length - 1;
    if (G.nodes.prev) G.nodes.prev.disabled = G.index <= 0;
    if (G.nodes.next) G.nodes.next.disabled = G.index >= last;
    if (G.nodes.restart) G.nodes.restart.disabled = false;
  }

  function updateCount() {
    if (!G.nodes.count) return;
    var total = Math.max(1, G.stages.length);
    G.nodes.count.textContent = '第 ' + (G.index + 1) + ' / ' + total + ' 幕 · ACT ' + roman(G.index);
  }

  /* -------------------------------------------------------------- 八幕一览 */
  function buildActList() {
    var sec = el('section', { className: 'pao-section' });
    var head = el('div', { className: 'pao-section__head' });
    head.appendChild(el('h3', { className: 'pao-section__title', text: '八幕一览' }));
    head.appendChild(el('p', { className: 'pao-section__hint', text: '每一幕都可以直接跳转，当前幕高亮显示。' }));
    sec.appendChild(head);

    var list = el('div', { className: 'pao-list pao-guided__acts' });
    G.nodes.actList = list;
    G.nodes.actRows = [];
    for (var i = 0; i < G.stages.length; i++) {
      var stage = G.stages[i] || {};
      var row = el('div', { className: 'pao-list__item pao-guided__act' });

      var top = el('div', { className: 'pao-list__head' });
      top.appendChild(el('span', { className: 'pao-mono pao-guided__act-num', text: 'ACT ' + roman(i) }));
      top.appendChild(el('span', { className: 'pao-guided__act-title', text: stage.title || '' }));
      row.appendChild(top);

      if (stage.titleEn) {
        row.appendChild(el('p', { className: 'pao-guided__act-en pao-mono', text: stage.titleEn }));
      }

      var meta = el('div', { className: 'pao-guided__act-meta' });
      meta.appendChild(el('span', { className: 'pao-tag', text: '聚焦 · ' + focusLabel(stage.focus || 'core') }));
      meta.appendChild(btn('跳到这一幕', 'jump', 'ghost', i));
      row.appendChild(meta);

      list.appendChild(row);
      G.nodes.actRows.push(row);
    }
    sec.appendChild(list);
    return sec;
  }

  function updateActList() {
    var rows = G.nodes.actRows || [];
    for (var i = 0; i < rows.length; i++) {
      rows[i].className = 'pao-list__item pao-guided__act' + (i === G.index ? ' is-current' : '');
    }
  }

  /* -------------------------------------------------------------- 关联模块 */
  function findModule(id) {
    var mods = (G.data && G.data.modules) || [];
    for (var i = 0; i < mods.length; i++) if (mods[i] && mods[i].id === id) return mods[i];
    return null;
  }

  function buildModuleCard(stage) {
    var focus = stage.focus || 'core';
    if (focus === 'core') return null;
    var mod = findModule(focus);
    if (!mod) return null;

    var card = el('div', { className: 'pao-guided__module' });
    var head = el('div', { className: 'pao-guided__module-head' });
    head.appendChild(el('span', { className: 'pao-tag', text: '关联模块' }));
    head.appendChild(el('span', { className: 'pao-mono pao-guided__module-id', text: String(mod.id || '').toUpperCase() }));
    card.appendChild(head);

    card.appendChild(el('p', { className: 'pao-guided__module-zh', text: (mod.zh || '') + ' · ' + (mod.name || '') }));
    if (mod.desc) card.appendChild(el('p', { className: 'pao-guided__module-desc', text: mod.desc }));

    var metrics = mod.metrics || [];
    if (metrics.length) {
      var kv = el('div', { className: 'pao-kv pao-guided__module-kv' });
      for (var i = 0; i < metrics.length; i++) {
        var m = metrics[i] || {};
        var row = el('div', { className: 'pao-kv__item' });
        row.appendChild(el('span', { className: 'pao-kv__k', text: m.k || '指标' }));
        row.appendChild(el('span', { className: 'pao-kv__v', text: String(m.v) }));
        kv.appendChild(row);
      }
      card.appendChild(kv);
    }

    var actions = el('div', { className: 'pao-guided__module-actions' });
    actions.appendChild(btn('打开该模块', 'module', 'ghost'));
    card.appendChild(actions);
    return card;
  }

  function openFocusModule() {
    var stage = G.stages[G.index];
    if (!stage || !stage.focus || stage.focus === 'core') return;
    go(stage.focus);
  }

  /* -------------------------------------------------------------- 倒计时 */
  function startCountdown() {
    stopCountdown();
    G.remainSec = Math.round(AUTO_MS / 1000);
    updateAutoHint();
    G.countdown = setInterval(function () {
      G.remainSec = Math.max(0, G.remainSec - 1);
      updateAutoHint();
    }, 1000);
  }

  function stopCountdown() {
    if (G.countdown) {
      clearInterval(G.countdown);
      G.countdown = null;
    }
    updateAutoHint();
  }

  function updateAutoHint() {
    var node = G.nodes.autoHint;
    if (!node) return;
    if (!G.auto) {
      node.textContent = '自动播放已关闭';
      return;
    }
    node.textContent = '距下一幕 ' + Math.max(0, G.remainSec) + ' 秒';
  }

  /* -------------------------------------------------------------- 键盘导航 */
  function bindKeys() {
    unbindKeys();
    G.keyHandler = function (ev) {
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ev.key === 'ArrowLeft') {
        goStage(G.index - 1);
        ev.preventDefault();
      } else if (ev.key === 'ArrowRight') {
        goStage(G.index + 1);
        ev.preventDefault();
      }
    };
    document.addEventListener('keydown', G.keyHandler);
  }

  function unbindKeys() {
    if (G.keyHandler) {
      document.removeEventListener('keydown', G.keyHandler);
      G.keyHandler = null;
    }
  }

  /* -------------------------------------------------------------- 自动播放 */
  function toggleAuto() {
    if (!G.stages.length) return;
    if (!G.auto && G.index >= G.stages.length - 1) {
      toast('info', '已在最后一幕', '回到前面的幕再开启自动播放。');
      return;
    }
    G.auto = !G.auto;
    syncSwitch();
    scheduleAuto();
    if (G.auto) toast('info', '自动播放已开启', '每 12 秒自动进入下一幕。');
    else toast('info', '自动播放已暂停', '可随时手动翻幕。');
  }

  function syncSwitch() {
    var sw = G.nodes.switch;
    if (!sw) return;
    sw.className = 'pao-switch' + (G.auto ? ' is-on' : '');
    sw.setAttribute('aria-checked', G.auto ? 'true' : 'false');
  }

  function scheduleAuto() {
    clearAuto();
    if (!G.auto) return;
    if (G.index >= G.stages.length - 1) {
      G.auto = false;
      syncSwitch();
      stopCountdown();
      updateAutoHint();
      toast('info', '自动播放已停止', '已到达最后一幕。');
      return;
    }
    startCountdown();
    G.timer = setTimeout(function () {
      G.timer = null;
      goStage(G.index + 1);
    }, AUTO_MS);
  }

  function clearAuto() {
    if (G.timer) {
      clearTimeout(G.timer);
      G.timer = null;
    }
    stopCountdown();
  }

  /* -------------------------------------------------------------- 交互分发 */
  function bindDelegates(wrap) {
    wrap.addEventListener('click', function (ev) {
      var node = closest(ev.target, '[data-gact]');
      if (!node) return;
      var act = node.getAttribute('data-gact');
      if (act === 'jump') {
        goStage(Number(node.getAttribute('data-index')));
        return;
      }
      switch (act) {
        case 'prev': goStage(G.index - 1); break;
        case 'next': goStage(G.index + 1); break;
        case 'restart':
          if (!G.stages.length) return;
          goStage(0);
          toast('info', '已重新开始', '从第一幕重新播放。');
          break;
        case 'exit':
          G.auto = false;
          syncSwitch();
          clearAuto();
          go('home');
          break;
        case 'auto': toggleAuto(); break;
        case 'module': openFocusModule(); break;
        case 'home': go('home'); break;
        case 'arch': go('architecture'); break;
        default: break;
      }
    });
  }

  function closest(node, sel) {
    while (node && node.nodeType) {
      if (node.nodeType === 1) {
        var fn = node.matches || node.msMatchesSelector || node.webkitMatchesSelector;
        if (fn && fn.call(node, sel)) return node;
        if (!fn && node.hasAttribute && node.hasAttribute(sel.slice(1, -1))) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 注册 */
  PAO.panels = PAO.panels || {};
  PAO.panels['guided'] = {
    id: 'guided',
    kicker: 'GUIDED EXPERIENCE',
    label: 'GUIDED TOUR',
    zh: '引导体验',
    tagline: 'EIGHT ACTS. ONE INTELLIGENCE.',
    taglineZh: '八幕，看懂个人智能系统。',
    badge: '约 3 分钟',

    render: render,

    onEnter: function (ctx) {
      G.ctx = ctx;
      bindKeys();
      if (G.stages.length) {
        setSceneStage(G.index);
        updateCount();
      }
    },

    onExit: function () {
      G.auto = false;
      syncSwitch();
      clearAuto();
      unbindKeys();
    }
  };
})(window.PAO = window.PAO || {});
