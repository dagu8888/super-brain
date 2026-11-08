/* PERSONAL AI OS — MODULE 01 · 个人记忆系统（PERSONAL MEMORY）
 * 归属：C · Panels-MC。只写本文件，不改他人文件。
 * 规范：ES5（var / function）、IIFE 包裹、不拼数据 innerHTML、颜色只取 CSS 变量、渲染幂等。
 * 数据契约见 docs/DATA-DICT.md：DATA.memories[] / DATA.memoryClusters[]。
 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};
  var D = PAO.dom;
/* ===== 1. 常量表 ===== */

  var CATS = [{ id: 'ALL', zh: '全部' }, { id: 'FACTS', zh: '事实' }, { id: 'EVENTS', zh: '事件' },
    { id: 'PREFERENCES', zh: '偏好' }, { id: 'RELATIONSHIPS', zh: '关系' },
    { id: 'GOALS', zh: '目标' }, { id: 'DECISIONS', zh: '决策' }];

  var CAT_ZH = {
    FACTS: '事实', EVENTS: '事件', PREFERENCES: '偏好',
    RELATIONSHIPS: '关系', GOALS: '目标', DECISIONS: '决策'
  };
  /* 类别色点：全部取 CSS 变量，不写死十六进制 */
  var CAT_COLOR = { FACTS: 'var(--cyan)', EVENTS: 'var(--ok)', PREFERENCES: 'var(--violet)',
    RELATIONSHIPS: 'var(--ice)', GOALS: 'var(--warn)', DECISIONS: 'var(--white)' };
  /* 来源类型 → 标签样式 + 中文注解（契约 §7：USER_PROVIDED / OBSERVED / INFERENCE 必须区分呈现） */
  var SRC = {
    USER_PROVIDED: { cls: 'pao-tag pao-tag--fact', zh: '用户事实' },
    OBSERVED: { cls: 'pao-tag pao-tag--observed', zh: '观察行为' },
    INFERENCE: { cls: 'pao-tag pao-tag--inference', zh: '模型推断' }
  };

  var VALIDITY = {
    ACTIVE: { zh: '有效', kind: 'ok', tip: '当前可被直接引用' },
    AGING: { zh: '趋于陈旧', kind: 'warn', tip: '超过复核周期，可信度缓降' },
    STALE: { zh: '已过期', kind: 'crit', tip: '默认不进入检索上下文' },
    CORRECTED: { zh: '已更正', kind: 'cyan', tip: '已被新版本覆盖' }
  };

  var SENS_ZH = { LOW: '低', MEDIUM: '中', HIGH: '高' };
/* ===== 2. 模块级状态（render 多次调用仍保持，onEnter 时恢复） ===== */

  var S = { q: '', cat: 'ALL', selectedId: null };   // 搜索词 / 类别筛选 / 当前选中记忆

  var T = { debounce: 0, chain: [] };   // 计时器句柄，onExit / render 时统一清理
  var offBus = null;                    // 事件订阅句柄
  var offReal = null;                   // 真实数据到达订阅句柄
  /* 最近一次 render 产出的节点与重绘函数，供 onEnter 恢复用 */
  var V = {
    input: null, seg: null, count: null, listHost: null, detailHost: null, statsHost: null,
    drawList: null, drawCount: null, drawDetail: null, drawStats: null, applyCat: null
  };
/* ===== 3. 基础工具 ===== */

  function isFn(f) { return typeof f === 'function'; }

  function el(tag, cls, kids, css) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (css) n.style.cssText = css;
    appendKids(n, kids);
    return n;
  }

  function appendKids(n, kids) {
    if (kids == null) return n;
    if (!Array.isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (typeof k === 'string' || typeof k === 'number') n.appendChild(document.createTextNode(String(k)));
      else if (k.nodeType) n.appendChild(k);
    }
    return n;
  }

  function tx(tag, cls, text, kids) {
    var n = el(tag, cls, kids);
    if (text != null) n.textContent = String(text);
    return n;
  }

  function nowIso() { return new Date().toISOString(); }

  function clrTimers() {
    if (T.debounce) { clearTimeout(T.debounce); T.debounce = 0; }
    for (var i = 0; i < T.chain.length; i++) clearTimeout(T.chain[i]);
    T.chain.length = 0;
  }

  function ctxData(ctx) { return (ctx && ctx.data) || PAO.DATA || {}; }
  function listMem(ctx) { var d = ctxData(ctx); return (d && d.memories) || []; }
  function listClusters(ctx) { var d = ctxData(ctx); return (d && d.memoryClusters) || []; }

  function findMem(ctx, id) {
    if (!id) return null;
    var arr = listMem(ctx);
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function findCluster(ctx, name) {
    var arr = listClusters(ctx);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].name === name || arr[i].zh === name || arr[i].id === name) return arr[i];
    }
    return null;
  }

  function U(ctx) { return (ctx && ctx.ui) || PAO.ui || {}; }

  function toast(ctx, kind, title, text) {
    var u = U(ctx);
    if (u && isFn(u.toast)) {
      try { u.toast(kind, title, text); return; } catch (err) { /* 降级 */ }
    }
    fallbackToast(kind, title, text);
  }
  /* shell 的 toast 未就绪时的兜底：保证任何点击都有可见反馈 */
  function fallbackToast(kind, title, text) {
    var color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)'
      : kind === 'crit' ? 'var(--crit)' : 'var(--cyan)';
    var host = document.getElementById('pao-toast-fallback');
    if (!host) {
      host = el('div', 'pao-toast-host');
      host.id = 'pao-toast-fallback';
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(host);
    }
    var card = el('div', 'pao-toast');
    card.style.cssText = 'background:var(--glass-2);border:1px solid var(--line);border-radius:var(--r-m);padding:10px 12px;min-width:180px;max-width:320px;';
    var t = tx('div', 'pao-toast__title', title);
    t.style.cssText = 'color:' + color + ';font-size:13px;line-height:1.5;';
    card.appendChild(t);
    if (text) card.appendChild(tx('div', 'pao-toast__text', text));
    host.appendChild(card);
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 2600);
  }
/* ===== 4. 结构原语（全部走契约 §4/§5 提供的样式类） ===== */

  function sec(title, hint) {
    var head = el('div', 'pao-section__head');
    head.appendChild(tx('div', 'pao-section__title', title));
    var hintEl = tx('div', 'pao-section__hint', hint || '');
    head.appendChild(hintEl);
    var body = el('div', null, null, 'display:grid;gap:8px;margin-top:9px;');
    var wrap = el('div', 'pao-section', [head, body]);
    return { wrap: wrap, body: body, hint: hintEl };
  }

  function kv(label, valueNode, extraCls) {
    var v = el('div', 'pao-kv__v');
    if (valueNode && valueNode.nodeType) v.appendChild(valueNode);
    else if (valueNode != null) v.textContent = String(valueNode);
    return el('div', 'pao-kv' + (extraCls ? ' ' + extraCls : ''),
      [tx('div', 'pao-kv__k', label), v]);
  }

  function btn(label, cls, iconName, fn) {
    var b = D.el('button', { type: 'button', className: cls });
    if (iconName) b.appendChild(D.icon(iconName, 14));
    b.appendChild(tx('span', null, label));
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      fn();
    });
    return b;
  }

  function mono(text) { return tx('span', 'pao-mono', text); }

  function confKind(v) {
    v = Number(v) || 0;
    if (v >= 0.8) return 'ok';
    if (v >= 0.6) return null;
    if (v >= 0.4) return 'warn';
    return 'crit';
  }
/* ===== 5. 主渲染 ===== */

  function render(root, ctx) {
    if (ctx && ctx.dom) D = ctx.dom;

    clrTimers();
    D.clear(root);

    var bus = ctx && ctx.bus;
    /* 外部（认知引擎的支撑记忆 chip）选中记忆时同步本面板 */
    if (bus && isFn(bus.on)) {
      if (offBus) { try { offBus(); } catch (e0) {} offBus = null; }
      offBus = bus.on('memory:select', function (p) {
        if (!p || !p.id || p.id === S.selectedId) return;
        S.selectedId = p.id;
        if (V.drawList) V.drawList();
        if (V.drawDetail) V.drawDetail();
      });
      /* 真实记忆数据到达后整面板重渲染（替换演示占位） */
      offReal = bus.on('memory:real-loaded', function () {
        S.selectedId = null;
        if (V.drawList) V.drawList();
        if (V.drawCluster) V.drawCluster();
        if (V.drawDetail) V.drawDetail();
        if (V.drawStats) V.drawStats();
      });
    }
    /* ---- 顶部工具条：搜索 + 类别分段 ---- */
    var top = sec('检索记忆', (PAO.DATA && PAO.DATA.memoryReal ? '真实记忆库 · ' : '') + '共 ' + D.fmt.num(listMem(ctx).length) + ' 条');

    var searchWrap = el('div', 'pao-search');
    searchWrap.appendChild(D.icon('search', 14));
    var input = D.el('input', {
      type: 'search',
      className: 'pao-search__input',
      placeholder: '搜索记忆内容、来源或标签',
      'aria-label': '搜索记忆内容、来源或标签',
      autocomplete: 'off'
    });
    input.value = S.q;
    searchWrap.appendChild(input);
    top.body.appendChild(searchWrap);

    var seg = el('div', 'pao-seg');
    var i;
    for (i = 0; i < CATS.length; i++) {
      (function (cat) {
        var item = D.el('button', {
          type: 'button',
          className: 'pao-seg__item' + (S.cat === cat.id ? ' is-active' : ''),
          text: cat.zh,
          'aria-pressed': S.cat === cat.id ? 'true' : 'false'
        });
        item.dataset.cat = cat.id;
        item.addEventListener('click', function (ev) {
          ev.preventDefault();
          V.applyCat(cat.id);
        });
        seg.appendChild(item);
      })(CATS[i]);
    }
    top.body.appendChild(seg);
    /* 输入即过滤，300ms 防抖 */
    input.addEventListener('input', function () {
      var val = input.value || '';
      if (T.debounce) clearTimeout(T.debounce);
      T.debounce = setTimeout(function () {
        S.q = String(val).trim();
        V.drawList();
        V.drawCount();
      }, 300);
    });

    root.appendChild(top.wrap);
    /* ---- 三个统计小卡 ---- */
    var statsHost = el('div', 'pao-grid-3');
    statsHost.style.cssText = 'margin-top:10px;';
    root.appendChild(statsHost);
    /* ---- 结果计数行 ---- */
    var count = tx('div', 'pao-section__hint pao-count', '');
    count.style.cssText = 'margin-top:10px;';
    root.appendChild(count);
    /* ---- 详情宿主（选中时浮在列表上方，列表保持） ---- */
    var detailHost = el('div', null, null, 'margin-top:10px;');
    root.appendChild(detailHost);
    /* ---- 列表宿主 ---- */
    var listHost = el('div', null, null, 'margin-top:10px;');
    root.appendChild(listHost);
    /* ---- 底部诚实声明 ---- */
    var foot = el('div', null, null, 'margin-top:16px;display:grid;gap:4px;');
    foot.appendChild(el('div', 'pao-divider'));
    foot.appendChild(tx('div', 'pao-section__hint', '真实记忆库 · 来源：元 AI 记忆库种子'));
    foot.appendChild(tx('div', 'pao-section__hint', '编辑仅作用于页面内存，持久化写入请走 POST /api/memory'));
    root.appendChild(foot);
    /* 保存节点引用，供 onEnter 复用 */
    V.input = input;
    V.seg = seg;
    V.count = count;
    V.statsHost = statsHost;
    V.detailHost = detailHost;
    V.listHost = listHost;
    /* ---- 列表点击（委托，一条监听器） ---- */
    listHost.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== listHost && !(t.getAttribute && t.getAttribute('data-mem-id'))) {
        t = t.parentNode;
      }
      if (t && t !== listHost && t.getAttribute) {
        var id = t.getAttribute('data-mem-id');
        if (id) select(id);
      }
    });
    /* ========== 内部函数：数据筛选 ========== */

    function filtered() {
      var arr = listMem(ctx);
      var out = [];
      for (var k = 0; k < arr.length; k++) {
        var m = arr[k];
        if (S.cat !== 'ALL' && m.category !== S.cat) continue;
        if (!hit(m, S.q)) continue;
        out.push(m);
      }
      out.sort(function (a, b) {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      return out;
    }

    function hit(m, q) {
      if (!q) return true;
      var tags = (m.tags || []).join(' ');
      var src = m.source || {};
      var hay = [m.title, m.content, m.categoryZh, m.cluster, src.label, src.typeZh, tags]
        .join(' ').toLowerCase();
      return hay.indexOf(String(q).toLowerCase()) > -1;
    }
    /* ========== 内部函数：重绘统计 ========== */

    function drawStats() {
      D.clear(statsHost);
      var arr = listMem(ctx);
      var sum = 0;
      var pending = 0;
      for (var k = 0; k < arr.length; k++) {
        sum += Number(arr[k].confidence) || 0;
        if (arr[k].validity !== 'ACTIVE') pending++;
      }
      var avg = arr.length ? sum / arr.length : 0;
      statsHost.appendChild(statCard('记忆总数', D.fmt.num(arr.length), '条', 'var(--cyan)'));
      statsHost.appendChild(statCard('平均置信度', D.fmt.pct(avg), '', 'var(--ok)'));
      statsHost.appendChild(statCard('待复核条数', D.fmt.num(pending), '条',
        pending > 0 ? 'var(--warn)' : 'var(--grey)'));
    }

    function statCard(label, value, unit, color) {
      var card = el('div', 'pao-metric');
      card.style.cssText = 'padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-s);';
      var v = el('div', 'pao-metric__v');
      var num = tx('span', null, value);
      num.style.cssText = 'color:' + color + ';';
      v.appendChild(num);
      if (unit) v.appendChild(tx('small', null, unit));
      card.appendChild(v);
      card.appendChild(tx('div', 'pao-metric__k', label));
      return card;
    }
    /* ========== 内部函数：重绘计数行 ========== */

    function drawCount() {
      var total = listMem(ctx).length;
      var shown = filtered().length;
      count.textContent = '共 ' + D.fmt.num(total) + ' 条 · 当前显示 ' + D.fmt.num(shown) + ' 条';
    }
    /* ========== 内部函数：重绘列表 ========== */

    function drawList() {
      D.clear(listHost);
      var rows = filtered();
      if (!rows.length) {
        var empty = el('div', 'pao-empty');
        var eic = el('div', 'pao-empty__icon');
        eic.appendChild(D.icon('search', 22));
        empty.appendChild(eic);
        empty.appendChild(tx('div', 'pao-empty__title', '没有匹配的记忆 · 试试其他关键词'));
        empty.appendChild(tx('div', 'pao-empty__text', '可以清空搜索框，或把类别切回「全部」再试一次。'));
        listHost.appendChild(empty);
        return;
      }
      var list = el('div', 'pao-list');
      for (var k = 0; k < rows.length; k++) list.appendChild(rowNode(rows[k]));
      listHost.appendChild(list);
    }

    function rowNode(m) {
      var src = m.source || {};
      var meta = SRC[src.type] || { cls: 'pao-tag', zh: src.typeZh || '未知来源' };

      var item = el('div', 'pao-list__item' + (S.selectedId === m.id ? ' is-active' : ''));
      item.setAttribute('data-mem-id', m.id);
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      var dot = el('i', null);
      dot.style.cssText = 'width:7px;height:7px;flex:none;border-radius:50%;background:' +
        (CAT_COLOR[m.category] || 'var(--grey)') + ';';
      item.appendChild(dot);

      var main = el('div', 'pao-list__main');
      main.appendChild(tx('div', 'pao-list__title', m.title || '未命名记忆'));
      main.appendChild(tx('div', 'pao-list__meta',
        (m.categoryZh || CAT_ZH[m.category] || m.category || '未分类') + ' · ' + (m.cluster || '未归簇')));
      item.appendChild(main);

      var aside = el('div', 'pao-list__aside');
      aside.appendChild(tx('span', meta.cls, meta.zh));
      aside.appendChild(tx('span', 'pao-mono', D.fmt.pct(m.confidence)));
      aside.appendChild(tx('span', 'pao-list__meta', D.fmt.ago(m.updatedAt)));
      item.appendChild(aside);

      item.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(m.id); }
      });
      return item;
    }
    /* ========== 内部函数：选中 ========== */

    function select(id) {
      S.selectedId = id;
      if (bus && isFn(bus.emit)) bus.emit('memory:select', { id: id });
      if (ctx && ctx.scene && isFn(ctx.scene.selectMemory)) {
        try { ctx.scene.selectMemory(id); } catch (err) { /* 场景未就绪 */ }
      }
      var items = listHost.querySelectorAll('.pao-list__item');
      for (var k = 0; k < items.length; k++) {
        var on = items[k].getAttribute('data-mem-id') === id;
        if (on) items[k].classList.add('is-active');
        else items[k].classList.remove('is-active');
      }
      drawDetail();
    }
    /* ========== 内部函数：详情 ========== */

    function drawDetail() {
      D.clear(detailHost);
      var m = findMem(ctx, S.selectedId);
      if (!m) { S.selectedId = null; return; }

      var inFilter = (S.cat === 'ALL' || m.category === S.cat) && hit(m, S.q);
      var s = sec('记忆详情', inFilter ? m.id : m.id + ' · 不在当前筛选结果内');
      /* 标题 + 类别 */
      var headline = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;');
      var dot = el('i', null);
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' +
        (CAT_COLOR[m.category] || 'var(--grey)') + ';';
      headline.appendChild(dot);
      var ht = tx('div', null, m.title || '未命名记忆');
      ht.style.cssText = 'font-size:15px;line-height:1.5;color:var(--white);';
      headline.appendChild(ht);
      if (m.edited) headline.appendChild(tx('span', 'pao-tag', '已编辑'));
      s.body.appendChild(headline);
      /* INFERENCE 强调卡（契约 §7 硬性要求） */
      if ((m.source || {}).type === 'INFERENCE') {
        var note = el('div', 'pao-note pao-note--warn');
        note.appendChild(D.icon('warning', 13));
        var nb = el('div', null, null, 'display:grid;gap:2px;min-width:0;');
        var nt = tx('div', null, '此条为模型推断，非用户明示');
        nt.style.cssText = 'color:var(--white);';
        nb.appendChild(nt);
        nb.appendChild(tx('div', null,
          '推断依据：' + ((m.source || {}).label || '未提供') + '；可随时更正或删除。'));
        note.appendChild(nb);
        s.body.appendChild(note);
      }

      s.body.appendChild(kv('记忆编号', mono(m.id || '—')));
      s.body.appendChild(kv('类别', (m.categoryZh || CAT_ZH[m.category] || '未分类') +
        '（' + (m.category || '—') + '）'));
      var cNode = el('div', null, null,
        'line-height:1.7;color:var(--white);white-space:pre-wrap;word-break:break-word;');
      cNode.textContent = m.content || '（内容为空）';
      s.body.appendChild(kv('内容', cNode, 'pao-kv--stack'));
      s.body.appendChild(kv('来源', srcNode(m), 'pao-kv--stack'));
      s.body.appendChild(kv('创建时间', D.fmt.time(m.createdAt) + ' · ' + D.fmt.ago(m.createdAt)));
      s.body.appendChild(kv('最后更新', D.fmt.time(m.updatedAt) + ' · ' + D.fmt.ago(m.updatedAt)));
      s.body.appendChild(kv('置信度', confNode(m)));
      s.body.appendChild(kv('有效期', validityNode(m)));
      s.body.appendChild(kv('敏感级别', (SENS_ZH[m.sensitivity] || m.sensitivity || '未标注') +
        '（' + (m.sensitivity || '—') + '）'));
      s.body.appendChild(kv('所属记忆簇', clusterNode(m)));
      s.body.appendChild(kv('关联记忆', linkNode(m), 'pao-kv--stack'));
      /* 操作区 */
      var acts = el('div', null, null, 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;');
      acts.appendChild(btn('编辑', 'pao-btn pao-btn--primary', 'edit', function () {
        openEdit(ctx, m);
      }));
      acts.appendChild(btn('标记为已过期', 'pao-btn pao-btn--ghost', 'warning', function () {
        markStale(ctx, m);
      }));
      s.body.appendChild(acts);

      var danger = el('div', 'pao-danger-zone');
      var dtitle = el('div', 'pao-danger-zone__title');
      dtitle.appendChild(D.icon('warning', 13));
      dtitle.appendChild(tx('span', null, '危险操作'));
      danger.appendChild(dtitle);
      danger.appendChild(tx('p', 'pao-danger-zone__text',
        '删除这条记忆会同时解除其关联引用，此操作仅作用于页面内存。'));
      var dacts = el('div', 'pao-danger-zone__actions');
      dacts.appendChild(btn('删除', 'pao-btn pao-btn--danger', 'trash', function () {
        removeMemory(ctx, m);
      }));
      danger.appendChild(dacts);
      s.body.appendChild(danger);

      detailHost.appendChild(s.wrap);
    }

    function srcNode(m) {
      var src = m.source || {};
      var meta = SRC[src.type] || { cls: 'pao-tag', zh: src.typeZh || '未知来源' };
      var wrap = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;');
      wrap.appendChild(tx('span', meta.cls, (src.typeZh || meta.zh)));
      wrap.appendChild(tx('span', 'pao-section__hint', src.label || '未标注来源'));
      if (src.ref) wrap.appendChild(mono(src.ref));
      return wrap;
    }

    function confNode(m) {
      var wrap = el('div', null, null,
        'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;');
      wrap.appendChild(D.bar(m.confidence || 0, confKind(m.confidence)));
      wrap.appendChild(tx('span', 'pao-num', D.fmt.pct(m.confidence)));
      return wrap;
    }

    function validityNode(m) {
      var v = VALIDITY[m.validity] || { zh: m.validity || '未标注', kind: 'muted', tip: '' };
      var wrap = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;');
      wrap.appendChild(D.badge((m.validity || '—') + ' · ' + v.zh, v.kind));
      if (v.tip) wrap.appendChild(tx('span', 'pao-section__hint', v.tip));
      return wrap;
    }

    function clusterNode(m) {
      var c = findCluster(ctx, m.cluster);
      var wrap = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;');
      var dot = el('i', null);
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:' +
        (c && c.color ? c.color : 'var(--grey)') + ';';
      wrap.appendChild(dot);
      wrap.appendChild(tx('span', null, m.cluster || '未归簇'));
      if (c && c.count != null) {
        wrap.appendChild(tx('span', 'pao-section__hint', '簇内 ' + D.fmt.num(c.count) + ' 条'));
      }
      return wrap;
    }

    function linkNode(m) {
      var links = m.links || [];
      if (!links.length) return tx('span', 'pao-section__hint', '暂无关联记忆');
      var wrap = el('div', null, null, 'display:flex;flex-wrap:wrap;gap:6px;');
      for (var k = 0; k < links.length; k++) {
        (function (id) {
          var target = findMem(ctx, id);
          var chip = D.el('button', {
            type: 'button',
            className: 'pao-chip' + (target ? '' : ' is-disabled'),
            text: target ? target.title : id
          });
          chip.setAttribute('title', id);
          chip.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (!target) { toast(ctx, 'warn', '关联记忆不存在', id + ' 不在当前记忆库中。'); return; }
            select(id);
          });
          wrap.appendChild(chip);
        })(links[k]);
      }
      return wrap;
    }
    /* ========== 内部函数：类别切换 ========== */

    function applyCat(id) {
      S.cat = id;
      var items = seg.querySelectorAll('.pao-seg__item');
      for (var k = 0; k < items.length; k++) {
        var on = items[k].getAttribute('data-cat') === id;
        if (on) items[k].classList.add('is-active');
        else items[k].classList.remove('is-active');
        items[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (bus && isFn(bus.emit)) bus.emit('memory:filter', { category: id });
      if (bus && isFn(bus.set)) bus.set({ memoryFilter: id });
      if (ctx && ctx.scene && isFn(ctx.scene.setMemoryFilter)) {
        try { ctx.scene.setMemoryFilter(id); } catch (err) { /* 场景未就绪 */ }
      }
      drawStats();
      drawCount();
      drawList();
      drawDetail();
    }
    /* 暴露给生命周期 / 事件回调 */
    V.drawList = drawList;
    V.drawCount = drawCount;
    V.drawDetail = drawDetail;
    V.drawStats = drawStats;
    V.applyCat = applyCat;
    /* 首次绘制 */
    drawStats();
    drawCount();
    drawList();
    drawDetail();
  }
/* ===== 6. 写操作：编辑 / 标记过期 / 删除 ===== */

  function openEdit(ctx, m) {
    var u = U(ctx);
    var ta = D.el('textarea', { className: 'pao-input pao-input--textarea', 'aria-label': '记忆内容' });
    ta.rows = 6;
    ta.value = m.content || '';
    ta.style.cssText = 'width:100%;min-height:120px;resize:vertical;background:var(--bg-1);' +
      'color:var(--white);border:1px solid var(--line);border-radius:var(--r-s);padding:9px 10px;' +
      'font-family:var(--font-ui);font-size:13px;line-height:1.65;';

    var counter = tx('div', 'pao-section__hint', '');
    function syncCount() {
      counter.textContent = '当前 ' + D.fmt.num(String(ta.value || '').length) + ' 字 · 建议 40–90 字';
    }
    syncCount();
    ta.addEventListener('input', syncCount);

    var body = el('div', null, null, 'display:grid;gap:8px;');
    body.appendChild(tx('div', 'pao-section__hint',
      '仅修改页面内存中的数据，不写入持久化存储。'));
    body.appendChild(ta);
    body.appendChild(counter);

    var done = false;
    function commit() {
      if (done) return true;
      var val = String(ta.value || '').trim();
      if (!val) {
        toast(ctx, 'warn', '内容不能为空', '请至少保留一句话再保存。');
        return false;
      }
      done = true;
      m.content = val;
      m.edited = true;
      m.updatedAt = nowIso();
      toast(ctx, 'ok', '记忆已更新（本地）', '仅作用于页面内存；持久化请走 POST /api/memory。');
      if (ctx && isFn(ctx.refresh)) ctx.refresh();
      return true;
    }
    /* Ctrl/⌘ + Enter 直接保存（弹层按钮无论由谁渲染都有一条可靠路径） */
    ta.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); commit(); }
    });

    /* shell.modal 的 action 契约：{ label, primary|danger, onClick(close) } */
    var opened = { fallback: true };
    if (u && isFn(u.modal)) {
      try {
        opened = u.modal({
          kicker: '编辑记忆 · ' + (m.id || ''),
          title: '修改记忆内容',
          body: body,
          actions: [
            { label: '取消', onClick: function (close) { if (isFn(close)) close(); } },
            {
              label: '保存修改',
              primary: true,
              onClick: function (close) {
                if (commit() && isFn(close)) close();
              }
            }
          ]
        });
      } catch (err0) { opened = null; }
    }
    /* 只有在弹层根节点缺失（shell.modal 返回 null）时才自建降级弹层 */
    if (opened === null) localModal('编辑记忆 · ' + (m.id || ''), '修改记忆内容', body, commit);
  }

  function markStale(ctx, m) {
    if (m.validity === 'STALE') {
      toast(ctx, 'info', '该条已是「已过期」', '有效期无需重复标记。');
      return;
    }
    confirmBox(ctx, {
      kicker: '有效期变更 · ' + (m.id || ''),
      title: '将这条记忆标记为已过期？',
      text: '「' + (m.title || m.id) + '」标记为 STALE 后，默认不再进入检索上下文，可随时改回。',
      danger: false,
      confirmText: '标记过期'
    }).then(function (ok) {
      if (!ok) return;
      m.validity = 'STALE';
      m.updatedAt = nowIso();
      toast(ctx, 'ok', '已标记为已过期', '该条将不再参与上下文检索。');
      if (ctx && isFn(ctx.refresh)) ctx.refresh();
    });
  }

  function removeMemory(ctx, m) {
    var arr = listMem(ctx);
    var refs = [];
    var k;
    for (k = 0; k < arr.length; k++) {
      if (arr[k].id === m.id) continue;
      var lk = arr[k].links || [];
      if (lk.indexOf(m.id) > -1) refs.push(arr[k]);
    }
    confirmBox(ctx, {
      kicker: '删除记忆 · ' + (m.id || ''),
      title: '确认删除这条记忆？',
      text: '「' + (m.title || m.id) + '」将从记忆库中移除；将同时解除 ' +
        refs.length + ' 条关联引用。本次移除仅作用于页面内存，不可撤销。',
      danger: true,
      confirmText: '确认删除'
    }).then(function (ok) {
      if (!ok) return;
      var i;
      for (i = 0; i < arr.length; i++) {
        if (arr[i].id === m.id) { arr.splice(i, 1); break; }
      }
      for (i = 0; i < refs.length; i++) {
        var links = refs[i].links || [];
        var p = links.indexOf(m.id);
        if (p > -1) links.splice(p, 1);
      }
      if (S.selectedId === m.id) S.selectedId = null;
      toast(ctx, 'ok', '已从记忆库移除', '同时解除 ' + refs.length + ' 条关联引用。');
      if (ctx && isFn(ctx.refresh)) ctx.refresh();
    });
  }
/* ===== 7. 弹层降级（shell 尚未就绪时也能真实操作） ===== */

  function confirmBox(ctx, opts) {
    var u = U(ctx);
    if (u && isFn(u.confirm)) {
      try {
        var p = u.confirm(opts);
        if (p && isFn(p.then)) return p;
      } catch (err) { /* 落到本地确认 */ }
    }
    return localConfirm(opts);
  }

  function localModal(kicker, title, bodyNode, onSave) {
    var mask = el('div', null, null,
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
      'background:var(--bg-0);padding:24px;');
    var card = el('div', null, null,
      'width:min(560px,90vw);background:var(--glass-2);border:1px solid var(--line);' +
      'border-radius:var(--r-l);padding:16px;display:grid;gap:10px;');
    card.appendChild(tx('div', 'pao-section__hint', kicker));
    card.appendChild(tx('div', null, title));
    card.appendChild(bodyNode);
    var row = el('div', null, null, 'display:flex;justify-content:flex-end;gap:8px;');
    var cancel = btn('取消', 'pao-btn pao-btn--ghost', null, function () { close(); });
    var save = btn('保存修改', 'pao-btn pao-btn--primary', 'check', function () { close(); onSave(); });
    row.appendChild(cancel);
    row.appendChild(save);
    card.appendChild(row);
    mask.appendChild(card);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.body.appendChild(mask);
    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
  }

  function localConfirm(opts) {
    return new Promise(function (resolve) {
      var mask = el('div', null, null,
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
        'background:var(--bg-0);padding:24px;');
      var card = el('div', null, null,
        'width:min(480px,88vw);background:var(--glass-2);border:1px solid ' +
        (opts && opts.danger ? 'var(--crit)' : 'var(--line)') +
        ';border-radius:var(--r-l);padding:16px;display:grid;gap:10px;');
      card.appendChild(tx('div', 'pao-section__hint', (opts && opts.kicker) || ''));
      card.appendChild(tx('div', null, (opts && opts.title) || '确认操作？'));
      if (opts && opts.text) card.appendChild(tx('div', 'pao-section__hint', opts.text));
      var row = el('div', null, null, 'display:flex;justify-content:flex-end;gap:8px;');
      row.appendChild(btn('取消', 'pao-btn pao-btn--ghost', null, function () { close(false); }));
      row.appendChild(btn((opts && opts.confirmText) || '确认',
        'pao-btn ' + (opts && opts.danger ? 'pao-btn--danger' : 'pao-btn--primary'), 'check',
        function () { close(true); }));
      card.appendChild(row);
      mask.appendChild(card);
      document.body.appendChild(mask);
      function close(v) {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(!!v);
      }
    });
  }
/* ===== 8. 注册 ===== */

  PAO.panels['memory'] = {
    id: 'memory',
    kicker: 'MODULE 01',
    label: 'PERSONAL MEMORY',
    zh: '个人记忆系统',
    tagline: 'EVERYTHING THAT MATTERS, REMEMBERED.',
    taglineZh: '所有重要的事，都被记住。',
    badge: '真实记忆库',

    render: function (root, ctx) { render(root, ctx); },

    onEnter: function (ctx) {
      /* 恢复模块级闭包状态（搜索词 / 类别 / 选中项） */
      if (ctx && ctx.store) {
        if (ctx.store.memoryFilter && ctx.store.memoryFilter !== S.cat) S.cat = ctx.store.memoryFilter;
        if (ctx.store.memorySelected) S.selectedId = ctx.store.memorySelected;
      }
      if (V.input && V.input.value !== S.q) V.input.value = S.q;
      if (ctx && ctx.scene && isFn(ctx.scene.setMemoryFilter)) {
        try { ctx.scene.setMemoryFilter(S.cat); } catch (e1) {}
      }
      if (V.applyCat) V.applyCat(S.cat);
    },

    onExit: function (ctx) {
      clrTimers();
      if (offBus) { try { offBus(); } catch (e2) {} offBus = null; }
      if (offReal) { try { offReal(); } catch (e3) {} offReal = null; }
      void ctx;
    }
  };
})(window.PAO = window.PAO || {});
