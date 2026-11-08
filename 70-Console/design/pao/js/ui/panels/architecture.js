/* PERSONAL AI OS · 七层架构 / SEVEN-LAYER STACK
 * 概念架构面板：所有分层、组件状态均为规划或模拟，不对应任何已上线的生产能力。
 */
(function (PAO) {
  'use strict';

  var HINT_DEFAULT = '提示：按住鼠标左键拖动可旋转视角，滚轮缩放';
  var HINT_ROTATE = '拖动画布旋转 · 滚轮缩放 · 本按钮仅提示操作方式';

  /* 组件状态：规划中 / 模拟 / 原型 */
  var STATE_TAG = {
    '规划中': { zh: '规划中', kind: 'muted' },
    '模拟': { zh: '模拟', kind: 'warn' },
    '原型': { zh: '原型', kind: 'ok' }
  };

  var S = {
    ctx: null,
    root: null,
    boundRoot: null,
    cards: [],
    openIndex: -1,
    exploded: false,
    explodeBtn: null,
    hintNode: null,
    timers: []
  };

  /* ============================ 基础工具 ============================ */
  function D() { return PAO.dom; }
  function el(tag, props, kids) { return PAO.dom.el(tag, props, kids); }
  function sx(v) { return v == null || v === '' ? '—' : String(v); }
  function mono(v, cls) { return el('span', { className: 'pao-mono' + (cls ? ' ' + cls : ''), text: sx(v) }); }
  function icon(name) { return D().icon ? D().icon(name, 14) : null; }
  function findAct(node) {
    var root = S.root;
    while (node && node !== root) { if (node.getAttribute && node.getAttribute('data-act')) return node; node = node.parentNode; }
    return null;
  }
  function later(fn, ms) { var t = window.setTimeout(fn, ms); S.timers.push(t); return t; }
  function clearTimers() {
    for (var i = 0; i < S.timers.length; i++) { try { window.clearTimeout(S.timers[i]); } catch (e) { /* noop */ } }
    S.timers.length = 0;
  }
  function uiOf(ctx) { return (ctx && ctx.ui) || PAO.ui || null; }
  function toast(kind, title, text) {
    try { var ui = uiOf(S.ctx); if (ui && typeof ui.toast === 'function') ui.toast(kind, title, text); }
    catch (e) { /* toast 不可用不影响主流程 */ }
  }
  function emit(name, payload) {
    try { if (PAO.bus && typeof PAO.bus.emit === 'function') PAO.bus.emit(name, payload); } catch (e) { /* noop */ }
  }
  function setStore(patch) {
    try { if (PAO.bus && typeof PAO.bus.set === 'function') PAO.bus.set(patch); } catch (e) { /* noop */ }
  }

  /* ============================ 数据读取 ============================ */
  function archOf(ctx) { var d = (ctx && ctx.data) || {}; return d.architecture || null; }
  function layersOf(ctx) { var a = archOf(ctx); return (a && a.layers) || []; }
  function sceneOf(ctx) { return (ctx && ctx.scene) || PAO.scene || null; }

  function stateTagOf(comp) {
    var raw = String((comp && comp.state) || '').trim();
    var meta = STATE_TAG[raw];
    if (meta) return meta;
    if (raw === 'PLANNED') return STATE_TAG['规划中'];
    if (raw === 'SIMULATED') return STATE_TAG['模拟'];
    if (raw === 'PROTOTYPE') return STATE_TAG['原型'];
    return { zh: raw || '未知', kind: 'muted' };
  }

  function countStates(layers) {
    var out = { '规划中': 0, '模拟': 0, '原型': 0, total: 0 };
    for (var i = 0; i < layers.length; i++) {
      var comps = (layers[i] && layers[i].components) || [];
      for (var c = 0; c < comps.length; c++) {
        var tag = stateTagOf(comps[c]);
        if (out[tag.zh] == null) out[tag.zh] = 0;
        out[tag.zh]++;
        out.total++;
      }
    }
    return out;
  }

  /* ============================ 场景联动 ============================ */
  function applyLayer(idx) {
    var sc = sceneOf(S.ctx);
    try { if (sc && typeof sc.setArchitectureLayer === 'function') sc.setArchitectureLayer(idx); } catch (e) { /* noop */ }
    emit('arch:layer', { index: idx });
    setStore({ archLayer: idx });
  }

  function applyExplode(on) {
    S.exploded = !!on;
    var sc = sceneOf(S.ctx);
    try { if (sc && typeof sc.explodeArchitecture === 'function') sc.explodeArchitecture(S.exploded); } catch (e) { /* noop */ }
    emit('arch:explode', { on: S.exploded });
    setStore({ archExploded: S.exploded });
    syncControls();
  }

  function syncControls() {
    if (!S.explodeBtn) return;
    S.explodeBtn.textContent = S.exploded ? '收拢分层' : '展开分层';
    S.explodeBtn.setAttribute('aria-pressed', S.exploded ? 'true' : 'false');
    S.explodeBtn.setAttribute('title', S.exploded ? '让七层回到紧凑堆叠' : '让七层在空间中分层展开');
  }

  function syncCards() {
    for (var i = 0; i < S.cards.length; i++) {
      var c = S.cards[i], open = c.idx === S.openIndex;
      if (c.body) { c.body.hidden = !open; c.body.style.display = open ? '' : 'none'; }
      if (c.node) {
        c.node.className = 'pao-layer-card' + (open ? ' is-open' : '');
        c.node.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      if (c.chev) c.chev.className = 'pao-layer-card__chev' + (open ? ' is-open' : '');
    }
    syncFocus();
  }

  /* 控制条上的「当前高亮」指示：与 3D 层高亮保持同一事实 */
  function syncFocus() {
    if (!S.focusNode) return;
    var layer = S.openIndex >= 0 ? layersOf(S.ctx)[S.openIndex] : null;
    S.focusNode.textContent = layer
      ? '当前高亮：' + sx(layer.code || layer.id) + ' · ' + sx(layer.zh)
      : '当前高亮：无 · 点选任一层可联动 3D';
    S.focusNode.className = 'pao-tag pao-tag--' + (layer ? 'ok' : 'muted') + ' pao-arch__focus';
  }

  /* ============================ 概览 ============================ */
  function buildOverview(ctx) {
    var layers = layersOf(ctx), counts = countStates(layers);
    var chips = el('div', { className: 'pao-arch__summary' }, [
      el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: '分层' }), mono(layers.length)]),
      el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: '组件' }), mono(counts.total)]),
      el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: '规划中' }), mono(counts['规划中'] || 0)]),
      el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: '模拟' }), mono(counts['模拟'] || 0)]),
      el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: '原型' }), mono(counts['原型'] || 0)])
    ]);
    return el('div', { className: 'pao-arch__intro' }, [
      el('p', {
        className: 'pao-section__hint',
        text: '从数据采集到用户体验的完整技术分层。记忆引擎与知识图谱已运行；各层组件按真实实现状态标注。'
      }),
      chips,
      el('p', { className: 'pao-section__hint pao-arch__legend', text: '组件状态图例：规划中＝尚未进入实现 · 模拟＝以本地数据验证接口 · 原型＝已有可交互原型 · 运行中＝已接入真实数据' })
    ]);
  }

  /* ============================ 控制条 ============================ */
  function buildControls() {
    var explodeBtn = el('button', {
      className: 'pao-btn pao-btn--primary', type: 'button', text: S.exploded ? '收拢分层' : '展开分层',
      dataset: { act: 'explode' }, 'aria-pressed': S.exploded ? 'true' : 'false'
    });
    var rotateBtn = el('button', {
      className: 'pao-btn pao-btn--ghost', type: 'button', text: '旋转视角', dataset: { act: 'rotate' }
    });
    var resetBtn = el('button', {
      className: 'pao-btn pao-btn--ghost', type: 'button', text: '重置', dataset: { act: 'reset' }
    });
    var focusNode = el('span', { className: 'pao-tag pao-tag--muted pao-arch__focus', text: '当前高亮：无' });
    var hintNode = el('span', { className: 'pao-section__hint pao-arch__hint', text: HINT_DEFAULT });
    S.explodeBtn = explodeBtn;
    S.focusNode = focusNode;
    S.hintNode = hintNode;
    return el('div', { className: 'pao-arch__bar' }, [explodeBtn, rotateBtn, resetBtn, focusNode, hintNode]);
  }

  /* ============================ 分层卡片 ============================ */
  function chipOf(comp) {
    var tag = stateTagOf(comp);
    return el('span', { className: 'pao-chip pao-arch__chip' }, [
      el('span', { className: 'pao-chip__name', text: sx(comp && (comp.zh || comp.name)) }),
      el('span', { className: 'pao-tag pao-tag--' + tag.kind, text: tag.zh })
    ]);
  }

  function buildDetail(layer) {
    var L = layer || {};
    var wrap = el('div', { className: 'pao-layer-card__detail' });
    wrap.appendChild(el('div', { className: 'pao-kv' }, [
      el('span', { className: 'pao-kv__k', text: '技术职责' }),
      el('span', { className: 'pao-kv__v', text: sx(L.dutyZh || L.duty) })
    ]));

    var grid = el('div', { className: 'pao-grid-2 pao-arch__io' }, [
      buildListBlock('输入', L.input),
      buildListBlock('输出', L.output)
    ]);
    wrap.appendChild(grid);
    wrap.appendChild(buildChipBlock('依赖', L.depends));
    if (L.note) {
      wrap.appendChild(el('p', { className: 'pao-section__hint', text: '备注：' + sx(L.note) }));
    }
    return wrap;
  }

  function buildListBlock(title, arr) {
    var box = el('div', { className: 'pao-arch__block' }, [
      el('span', { className: 'pao-section__title', text: title })
    ]);
    var list = el('div', { className: 'pao-list pao-arch__list' });
    if (arr && arr.length) {
      for (var i = 0; i < arr.length; i++) {
        list.appendChild(el('div', { className: 'pao-list__item pao-arch__list-item', text: sx(arr[i]) }));
      }
    } else {
      list.appendChild(el('div', { className: 'pao-empty', text: '暂无' }));
    }
    box.appendChild(list);
    return box;
  }

  function buildChipBlock(title, arr) {
    var box = el('div', { className: 'pao-arch__block' }, [
      el('span', { className: 'pao-section__title', text: title })
    ]);
    var row = el('div', { className: 'pao-arch__depends' });
    if (arr && arr.length) {
      for (var i = 0; i < arr.length; i++) row.appendChild(el('span', { className: 'pao-chip', text: sx(arr[i]) }));
    } else {
      row.appendChild(el('span', { className: 'pao-section__hint', text: '无' }));
    }
    box.appendChild(row);
    return box;
  }

  function buildCard(ctx, layer, idx, total) {
    var L = layer || {};
    var comps = L.components || [];
    var open = idx === S.openIndex;
    var chips = el('div', { className: 'pao-layer-card__chips' });
    for (var c = 0; c < comps.length; c++) chips.appendChild(chipOf(comps[c]));

    var chev = el('span', { className: 'pao-layer-card__chev' + (open ? ' is-open' : '') }, [icon('chevron')]);
    var body = el('div', { className: 'pao-layer-card__body' }, [buildDetail(L)]);
    body.hidden = !open;
    if (!open) body.style.display = 'none';

    var card = el('article', {
      className: 'pao-layer-card' + (open ? ' is-open' : ''), role: 'button', tabindex: '0',
      'aria-expanded': open ? 'true' : 'false',
      dataset: { act: 'layer', idx: String(idx) },
      title: '点击展开第 ' + (idx + 1) + ' 层技术细节'
    }, [
      el('div', { className: 'pao-layer-card__head' }, [
        mono(sx(L.code || L.id), 'pao-layer-card__code'),
        el('div', { className: 'pao-layer-card__title' }, [
          el('span', { className: 'pao-layer-card__en', text: sx(L.name) }),
          el('span', { className: 'pao-layer-card__zh', text: sx(L.zh) })
        ]),
        el('span', { className: 'pao-layer-card__duty', text: sx(L.duty) }),
        el('span', { className: 'pao-tag pao-tag--muted pao-layer-card__count', text: (idx + 1) + '/' + total }),
        chev
      ]),
      chips,
      body
    ]);

    S.cards.push({ idx: idx, node: card, body: body, chev: chev });
    return card;
  }

  /* ============================ 交互行为 ============================ */
  function toggleCard(rawIdx) {
    var idx = parseInt(rawIdx, 10);
    if (isNaN(idx)) return;
    if (S.openIndex === idx) {
      S.openIndex = -1;
      applyLayer(-1);
      syncCards();
      toast('info', '已收起该层', '第 ' + (idx + 1) + ' 层已回到折叠状态，3D 高亮清除。');
      return;
    }
    S.openIndex = idx;
    applyLayer(idx);
    syncCards();
    var layer = layersOf(S.ctx)[idx];
    if (layer) toast('info', '已聚焦 ' + sx(layer.code || layer.id), sx(layer.zh) + ' · 3D 层高亮已联动。');
  }

  function toggleExplode() {
    applyExplode(!S.exploded);
    toast('info', S.exploded ? '已展开分层' : '已收拢分层',
      S.exploded ? '七层已在空间中分离，可逐层点击查看。' : '七层已回到紧凑堆叠状态。');
  }

  function rotateHint() {
    if (S.hintNode) S.hintNode.textContent = HINT_ROTATE;
    clearTimers();
    later(function () { if (S.hintNode) S.hintNode.textContent = HINT_DEFAULT; }, 4200);
    toast('info', '旋转视角', '按住鼠标左键拖动即可旋转视角；滚轮缩放，触控板双指同样可用。');
  }

  function resetAll() {
    S.openIndex = -1;
    S.exploded = false;
    applyLayer(-1);
    var sc = sceneOf(S.ctx);
    try { if (sc && typeof sc.explodeArchitecture === 'function') sc.explodeArchitecture(false); } catch (e) { /* noop */ }
    emit('arch:explode', { on: false });
    setStore({ archLayer: -1, archExploded: false });
    if (S.hintNode) S.hintNode.textContent = HINT_DEFAULT;
    syncControls();
    syncCards();
    toast('info', '已重置', '分层已收拢、层高亮已清除，视角回到全景。');
  }

  /* ============================ 事件与渲染 ============================ */
  function onClick(ev) {
    var node = findAct(ev.target);
    if (!node) return;
    var act = node.getAttribute('data-act');
    if (act === 'layer') { toggleCard(node.getAttribute('data-idx')); return; }
    if (act === 'explode') { toggleExplode(); return; }
    if (act === 'rotate') { rotateHint(); return; }
    if (act === 'reset') { resetAll(); return; }
  }

  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var node = ev.target;
    if (!node || !node.getAttribute || !node.getAttribute('data-act')) return;
    ev.preventDefault();
    onClick(ev);
  }

  function render(root, ctx) {
    S.ctx = ctx; S.root = root; S.cards = []; S.openIndex = -1;
    S.explodeBtn = null; S.focusNode = null; S.hintNode = null;
    D().clear(root);

    var layers = layersOf(ctx);
    if (!layers.length) {
      root.appendChild(el('div', {
        className: 'pao-empty', text: '架构数据未就绪 · 请确认 js/data/mock-data.js 已加载后重新进入本面板'
      }));
      return;
    }

    var shell = el('div', { className: 'pao-panel pao-arch' });
    shell.appendChild(buildOverview(ctx));
    shell.appendChild(buildControls());

    var stack = el('div', { className: 'pao-arch__stack' });
    var total = layers.length;
    /* L1 在最下、L7 在最上：数组倒序展示，点击时仍用原始下标定位 3D 层 */
    for (var i = total - 1; i >= 0; i--) stack.appendChild(buildCard(ctx, layers[i], i, total));
    shell.appendChild(stack);

    shell.appendChild(el('div', { className: 'pao-divider' }));
    shell.appendChild(el('p', {
      className: 'pao-section__hint pao-arch__foot',
      text: '当前阶段：本地记忆引擎、知识图谱与云脑接入已运行；以上分层中未标注「运行中」的组件为规划或模拟。'
    }));
    root.appendChild(shell);

    if (S.boundRoot !== root) {
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKey);
      S.boundRoot = root;
    }

    syncControls();
    syncCards();
  }

  function onEnter(ctx) {
    S.ctx = ctx;
    var sc = sceneOf(ctx);
    try { if (sc && typeof sc.setMode === 'function') sc.setMode('architecture'); } catch (e) { /* noop */ }
    applyLayer(S.openIndex >= 0 ? S.openIndex : -1);
  }

  function onExit(ctx) {
    clearTimers();
    var sc = sceneOf(ctx || S.ctx);
    var mode = sc && sc.mode;
    try {
      if (sc && typeof sc.setArchitectureLayer === 'function') sc.setArchitectureLayer(-1);
      if (sc && typeof sc.explodeArchitecture === 'function') sc.explodeArchitecture(false);
    } catch (e) { /* noop */ }
    S.openIndex = -1;
    S.exploded = false;
    setStore({ archLayer: -1, archExploded: false });
    if (mode === 'architecture' && sc && typeof sc.setMode === 'function') {
      try { sc.setMode('universe'); } catch (e) { /* noop */ }
    }
  }

  /* ============================ 注册面板 ============================ */
  PAO.panels = PAO.panels || {};
  PAO.panels['architecture'] = {
    id: 'architecture',
    kicker: 'SYSTEM ARCHITECTURE',
    label: 'SEVEN-LAYER STACK',
    zh: '七层技术架构',
    tagline: 'SEVEN LAYERS. ONE PERSONAL INTELLIGENCE.',
    taglineZh: '七层结构，一个个人智能。',
    badge: '概念架构',
    render: render,
    onEnter: onEnter,
    onExit: onExit
  };
})(window.PAO = window.PAO || {});
