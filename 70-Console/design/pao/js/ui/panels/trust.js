/* PERSONAL AI OS · MODULE 06 — 权限与信任 / PERMISSION & TRUST
 * 全部行为均为本地模拟：不触达真实账户、不执行真实云端删除、不修改真实授权。 */
(function (PAO) {
  'use strict';
  var HIGH_DELTA = 0.03, FLOOR_SCORE = 0.4, RESTORE_MS = 30000, PACK_MS = 1200, DELETE_WORD = '删除全部记忆';
  var RISK_META = {
    HIGH: { level: 'HIGH', zh: '高风险', kind: 'crit' },
    MEDIUM: { level: 'MEDIUM', zh: '中风险', kind: 'warn' },
    LOW: { level: 'LOW', zh: '低风险', kind: 'muted' }
  };
  var STATE_META = {
    GRANTED: { zh: '已授权', kind: 'ok' },
    REVOKED: { zh: '已撤销', kind: 'muted' },
    PENDING: { zh: '待确认', kind: 'warn' }
  };
  var RESULT_META = {
    ALLOWED: { zh: '已允许', kind: 'cyan' },
    DENIED: { zh: '已拒绝', kind: 'crit' },
    PENDING: { zh: '待确认', kind: 'warn' }
  };
  var FILTERS = [{ id: 'ALL', zh: '全部' }, { id: 'ALLOWED', zh: '已允许' }, { id: 'DENIED', zh: '已拒绝' }];
  /* 模块内状态：折叠开关 / 局部刷新器 / 计时器 / 待还原的记忆快照 */
  var S = {
    ctx: null, root: null, boundRoot: null, sections: {}, updaters: [], refs: {},
    open: { rating: true, perms: true, prov: true, audit: true, danger: true },
    auditFilter: 'ALL', timers: [], pendingRestore: null, auditSeq: 0
  };
  /* ============================ 基础工具 ============================ */
  function D() { return PAO.dom; }
  function el(tag, props, kids) { return PAO.dom.el(tag, props, kids); }
  function sx(v) { return v == null || v === '' ? '—' : String(v); }
  function mono(v, cls) { return el('span', { className: 'pao-mono' + (cls ? ' ' + cls : ''), text: sx(v) }); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtOf(ctx) { return (ctx && ctx.dom && ctx.dom.fmt) || (PAO.dom && PAO.dom.fmt) || null; }
  function timeText(ctx, iso) { var f = fmtOf(ctx), o = f && f.time ? f.time(iso) : sx(iso); return o || '—'; }
  function agoText(ctx, iso) {
    if (!iso) return '从未使用';
    var f = fmtOf(ctx), o = f && f.ago ? f.ago(iso) : sx(iso);
    return o && o !== '—' ? o : sx(iso);
  }
  function kv(label, valueNode, note) {
    return el('div', { className: 'pao-kv', title: note || '' }, [
      el('span', { className: 'pao-kv__k', text: label }), el('span', { className: 'pao-kv__v' }, [valueNode])
    ]);
  }
  function findAct(node) {
    var root = S.root;
    while (node && node !== root) { if (node.getAttribute && node.getAttribute('data-act')) return node; node = node.parentNode; }
    return null;
  }
  function later(fn, ms) { var t = window.setTimeout(fn, ms); S.timers.push(t); return t; }
  function every(fn, ms) { var t = window.setInterval(fn, ms); S.timers.push(t); return t; }
  function killTimer(t) {
    try { window.clearTimeout(t); window.clearInterval(t); } catch (e) { /* noop */ }
    for (var i = S.timers.length - 1; i >= 0; i--) if (S.timers[i] === t) S.timers.splice(i, 1);
  }
  function clearTimers() {
    for (var i = 0; i < S.timers.length; i++) { try { window.clearTimeout(S.timers[i]); window.clearInterval(S.timers[i]); } catch (e) { /* noop */ } }
    S.timers.length = 0;
  }
  function uiOf(ctx) { return (ctx && ctx.ui) || PAO.ui || null; }
  function toast(kind, title, text) {
    try { var ui = uiOf(S.ctx); if (ui && typeof ui.toast === 'function') ui.toast(kind, title, text); } catch (e) { /* toast 不可用不影响主流程 */ }
  }
  function emit(name, payload) {
    try { if (PAO.bus && typeof PAO.bus.emit === 'function') PAO.bus.emit(name, payload); } catch (e) { /* noop */ }
  }
  function confirmBox(ctx, opts) {
    return new Promise(function (resolve) {
      var ui = uiOf(ctx);
      if (ui && typeof ui.confirm === 'function') {
        Promise.resolve(ui.confirm(opts)).then(function (v) { resolve(!!v); }, function () { resolve(false); });
        return;
      }
      try { resolve(window.confirm(String(opts.title || '') + '\n\n' + String(opts.text || ''))); } catch (e) { resolve(false); }
    });
  }
  function closeModal(handle) {
    try {
      if (handle && typeof handle.close === 'function') { handle.close(); return; }
      var btn = document.querySelector('.pao-modal__close, [data-pao-modal-close], .pao-modal [data-act="close"]');
      if (btn && typeof btn.click === 'function') btn.click();
    } catch (e) { /* 关闭失败不影响已完成的操作 */ }
  }
  /* ============================ 数据读取 ============================ */
  function trustOf(ctx) { var d = (ctx && ctx.data) || {}; return d.trust || null; }
  function permsOf(ctx) { var t = trustOf(ctx); return (t && t.permissions) || []; }
  function auditOf(ctx) { var t = trustOf(ctx); return (t && t.audit) || []; }
  function provOf(ctx) { var t = trustOf(ctx); return (t && t.provenance) || []; }
  function memoriesOf(ctx) { var d = (ctx && ctx.data) || {}; return d.memories || []; }
  function memoryById(ctx, id) { var l = memoriesOf(ctx); for (var i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i]; return null; }
  function findPerm(ctx, id) { var l = permsOf(ctx); for (var i = 0; i < l.length; i++) if (l[i] && String(l[i].id) === String(id)) return l[i]; return null; }
  function riskOf(p) {
    var raw = String((p && (p.risk || p.riskZh)) || '').toUpperCase();
    return raw === 'HIGH' || raw.indexOf('高') > -1 ? RISK_META.HIGH
      : raw === 'MEDIUM' || raw.indexOf('中') > -1 ? RISK_META.MEDIUM : RISK_META.LOW;
  }
  function stateKey(p) { var s = String((p && p.state) || 'GRANTED').toUpperCase(); return STATE_META[s] ? s : 'PENDING'; }
  function stateOf(p) {
    var m = STATE_META[stateKey(p)] || STATE_META.PENDING;
    return { zh: String((p && p.stateZh) || m.zh), kind: m.kind };
  }
  function resultOf(rec) {
    var k = String((rec && rec.result) || 'ALLOWED').toUpperCase(), m = RESULT_META[k] || RESULT_META.ALLOWED;
    return { key: k, zh: String((rec && rec.resultZh) || m.zh), kind: m.kind };
  }
  function statsOf(ctx) {
    var perms = permsOf(ctx), audits = auditOf(ctx), pending = 0, high = 0, i, p;
    for (i = 0; i < perms.length; i++) {
      p = perms[i];
      if (!p) continue;
      if (stateKey(p) === 'PENDING') pending++;
      if (riskOf(p).level === 'HIGH' && stateKey(p) === 'GRANTED') high++;
    }
    for (i = 0; i < audits.length; i++) if (audits[i] && String(audits[i].result || '').toUpperCase() === 'PENDING') pending++;
    return { open: pending, high: high, audit: audits.length, total: perms.length };
  }
  function scoreOf(ctx) { var v = Number((trustOf(ctx) || {}).score); return isNaN(v) ? 0 : Math.max(0, Math.min(1, v)); }
  function bumpScore(ctx, delta) {
    var t = trustOf(ctx), v = Number(t && t.score);
    if (!t || isNaN(v)) return;
    try { t.score = Math.max(0, Math.min(1, Math.round((v + delta) * 1000) / 1000)); } catch (e) { /* 只读数据时跳过 */ }
  }
  function setScore(ctx, v) { var t = trustOf(ctx); try { if (t) t.score = Math.max(0, Math.min(1, Number(v) || 0)); } catch (e) { /* 只读数据时跳过 */ } }
  function writeAudit(ctx, action, target, result, detail) {
    var t = trustOf(ctx), res = String(result || 'ALLOWED').toUpperCase();
    if (!t) return null;
    if (!t.audit) t.audit = [];
    var meta = RESULT_META[res] || RESULT_META.ALLOWED;
    S.auditSeq++;
    try {
      t.audit.unshift({
        id: 'AUD-DEMO-' + (100 + S.auditSeq), ts: new Date().toISOString(), actor: '你', action: action,
        target: target, result: res, resultZh: meta.zh, detail: detail || '本地模拟记录 · 未调用外部服务'
      });
    } catch (e) { return null; }
    return t.audit[0];
  }
  function shortHash(h) { var s = String(h || ''); return s ? (s.length > 12 ? s.slice(0, 12) + '…' : s) : '—'; }
  /* ============================ 折叠区块 ============================ */
  function section(key, title, hint, body) {
    var bodyWrap = el('div', { className: 'pao-section__body' }, [body]);
    bodyWrap.hidden = !S.open[key];
    if (!S.open[key]) bodyWrap.style.display = 'none';
    var head = el('div', {
      className: 'pao-section__head', dataset: { act: 'fold', key: key }, role: 'button', tabindex: '0',
      'aria-expanded': S.open[key] ? 'true' : 'false', title: S.open[key] ? '点击收起' : '点击展开'
    }, [
      el('span', { className: 'pao-section__title', text: title }),
      hint ? el('span', { className: 'pao-section__hint', text: hint }) : null,
      el('span', { className: 'pao-section__chev' }, [D().icon('chevron', 14)])
    ]);
    var sec = el('section', { className: 'pao-section' + (S.open[key] ? '' : ' is-collapsed') }, [head, bodyWrap]);
    sec.setAttribute('data-section', key); S.sections[key] = { sec: sec, body: bodyWrap, head: head };
    return sec;
  }
  function toggleFold(node) {
    var key = node.getAttribute('data-key');
    if (!key) return;
    S.open[key] = !S.open[key];
    var sec = S.sections[key];
    if (!sec) return;
    if (sec.body) { sec.body.hidden = !S.open[key]; sec.body.style.display = S.open[key] ? '' : 'none'; }
    if (sec.sec) {
      if (S.open[key]) sec.sec.className = sec.sec.className.replace(' is-collapsed', '');
      else if (sec.sec.className.indexOf('is-collapsed') === -1) sec.sec.className += ' is-collapsed';
    }
    node.setAttribute('aria-expanded', S.open[key] ? 'true' : 'false');
    node.setAttribute('title', S.open[key] ? '点击收起' : '点击展开');
  }
  /* ============================ ① 信任评级 ============================ */
  function buildRating(ctx) {
    var ringBox = el('div', { className: 'pao-rating__ring' });
    var numNode = el('span', { className: 'pao-num', text: '0' });
    var decNode = el('span', { className: 'pao-mono', text: '0.00' });
    var openNode = mono('0'), highNode = mono('0'), auditNode = mono('0');
    var hero = el('div', { className: 'pao-grid-2 pao-rating__hero' }, [
      ringBox,
      el('div', { className: 'pao-rating__figure' }, [
        el('div', { className: 'pao-rating__value' }, [numNode, el('span', { className: 'pao-rating__unit', text: '/100' })]),
        el('div', { className: 'pao-rating__sub' }, [
          el('span', { text: '综合信任评分' }), el('span', { className: 'pao-rating__dot', text: '·' }), decNode
        ])
      ])
    ]);
    var metrics = el('div', { className: 'pao-list pao-rating__metrics' }, [
      kv('开放风险项', openNode, '待确认权限与待确认审计条目合计'),
      kv('高风险权限数', highNode, '当前仍处于已授权状态的高风险权限'),
      kv('最近审计条数', auditNode, '含本次会话新增的模拟记录')
    ]);
    var layers = (trustOf(ctx) || {}).layers || [], layerChips = el('div', { className: 'pao-rating__layers' });
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i] || {};
      layerChips.appendChild(el('span', { className: 'pao-chip' }, [el('span', { className: 'pao-chip__k', text: sx(L.id).toUpperCase() }), el('span', { text: sx(L.zh) })]));
    }
    var body = el('div', { className: 'pao-rating' }, [
      hero, metrics,
      layers.length ? el('div', { className: 'pao-divider' }) : null,
      layers.length ? layerChips : null,
      el('p', { className: 'pao-section__hint', text: '安全评级由本地规则模拟计算：撤销高风险权限评分 −0.03，恢复则 +0.03，取值区间 0–1。' })
    ]);
    function update() {
      var v = scoreOf(ctx), st = statsOf(ctx);
      D().clear(ringBox);
      ringBox.appendChild(D().ring(v, { size: 104 }));
      numNode.textContent = String(Math.round(v * 100));
      decNode.textContent = v.toFixed(2);
      openNode.textContent = String(st.open);
      highNode.textContent = String(st.high);
      auditNode.textContent = String(st.audit);
    }
    update();
    return { node: section('rating', '信任评级', '本地规则模拟', body), update: update };
  }
  /* ============================ ② 权限管理 ============================ */
  function buildPermissions(ctx) {
    var perms = permsOf(ctx), list = el('div', { className: 'pao-list pao-perm-list' }), refs = {};
    if (!perms.length) {
      return {
        node: section('perms', '权限管理', '权限数据未就绪',
          el('div', { className: 'pao-empty', text: '暂无权限项 · 数据加载后重新进入本面板' })),
        update: function () {}
      };
    }
    for (var i = 0; i < perms.length; i++) {
      var p = perms[i] || {}, risk = riskOf(p), st = stateOf(p), on = stateKey(p) === 'GRANTED';
      var stateBadge = D().badge(st.zh, st.kind);
      var usedNode = el('span', { className: 'pao-perm__used', text: '最近使用：' + agoText(ctx, p.lastUsed) });
      var sw = el('button', {
        className: 'pao-switch' + (on ? ' is-on' : ''), type: 'button', role: 'switch',
        'aria-checked': on ? 'true' : 'false', 'aria-label': sx(p.zh || p.id) + ' 授权开关',
        title: on ? '点击撤销授权' : '点击恢复授权', dataset: { act: 'perm', id: String(p.id || ('perm-' + i)) }
      }, [el('span', { className: 'pao-switch__knob' })]);
      var row = el('div', { className: 'pao-list__item pao-perm', 'data-pid': String(p.id || '') }, [
        el('div', { className: 'pao-perm__head' }, [
          el('div', { className: 'pao-perm__name' }, [
            el('span', { className: 'pao-perm__zh', text: sx(p.zh || p.id) }), mono(p.scope, 'pao-perm__scope')
          ]),
          el('div', { className: 'pao-perm__badges' }, [D().badge(risk.zh, risk.kind), stateBadge])
        ]),
        el('div', { className: 'pao-perm__meta' }, [
          el('span', { text: '目标系统：' + sx(p.target) }), usedNode,
          p.note ? el('span', { className: 'pao-perm__note', text: sx(p.note) }) : null
        ]),
        sw
      ]);
      refs[String(p.id)] = { badge: stateBadge, sw: sw, used: usedNode };
      list.appendChild(row);
    }
    function update() {
      var live = permsOf(ctx);
      for (var j = 0; j < live.length; j++) {
        var q = live[j] || {}, r = refs[String(q.id)];
        if (!r) continue;
        var s = stateOf(q), isOn = stateKey(q) === 'GRANTED';
        r.badge.className = 'pao-badge pao-badge--' + s.kind;
        r.badge.textContent = s.zh;
        r.sw.className = 'pao-switch' + (isOn ? ' is-on' : '');
        r.sw.setAttribute('aria-checked', isOn ? 'true' : 'false');
        r.sw.setAttribute('title', isOn ? '点击撤销授权' : '点击恢复授权');
        r.used.textContent = '最近使用：' + agoText(ctx, q.lastUsed);
      }
    }
    return {
      node: section('perms', '权限管理', perms.length + ' 项授权 · 切换仅改写本地演练状态', list),
      update: update
    };
  }
  /* ============================ ③ 数据溯源 ============================ */
  function buildProvenance(ctx) {
    var list = el('div', { className: 'pao-list pao-prov' });
    function draw() {
      D().clear(list);
      var prov = provOf(ctx);
      if (!prov.length) { list.appendChild(el('div', { className: 'pao-empty', text: '暂无可溯源记录' })); return; }
      for (var i = 0; i < prov.length; i++) {
        var item = prov[i] || {}, mem = memoryById(ctx, item.memoryId), chain = item.chain || [];
        var chainRow = el('div', { className: 'pao-prov__chain' });
        for (var c = 0; c < chain.length; c++) {
          if (c) chainRow.appendChild(el('span', { className: 'pao-prov__arrow', text: '→', 'aria-hidden': 'true' }));
          chainRow.appendChild(el('span', { className: 'pao-chip pao-prov__step', text: sx(chain[c]) }));
        }
        if (!chain.length) chainRow.appendChild(el('span', { className: 'pao-section__hint', text: '链路数据缺失' }));
        list.appendChild(el('div', { className: 'pao-list__item pao-prov__item' }, [
          el('div', { className: 'pao-prov__head' }, [
            el('span', { className: 'pao-prov__title', text: mem ? sx(mem.title) : '记忆已删除（模拟）' }),
            mono(item.memoryId)
          ]),
          chainRow,
          el('div', { className: 'pao-prov__foot' }, [
            el('span', { className: 'pao-prov__hash' }, [
              el('span', { className: 'pao-section__hint', text: '哈希短码 ' }), mono(shortHash(item.hash))
            ]),
            el('button', {
              className: 'pao-btn pao-btn--ghost', type: 'button', text: '查看完整链路',
              dataset: { act: 'chain', id: String(item.memoryId || '') }
            })
          ])
        ]));
      }
    }
    draw();
    return { node: section('prov', '数据溯源', 'Provenance · 来源链与哈希校验位', list), update: draw };
  }
  function showChain(ctx, memoryId) {
    var prov = provOf(ctx), item = null, i, s, k;
    for (i = 0; i < prov.length; i++) if (prov[i] && String(prov[i].memoryId) === String(memoryId)) item = prov[i];
    if (!item) { toast('warn', '链路缺失', '没有找到记忆 ' + memoryId + ' 的溯源记录。'); return; }
    var mem = memoryById(ctx, memoryId), chain = item.chain || [];
    var steps = el('div', { className: 'pao-list pao-prov__detail' });
    for (s = 0; s < chain.length; s++) {
      steps.appendChild(el('div', { className: 'pao-list__item pao-prov__step-row' }, [mono('0' + (s + 1)), el('span', { text: sx(chain[s]) })]));
    }
    var meta = el('div', { className: 'pao-list' }, [
      kv('记忆编号', mono(memoryId)),
      kv('记忆标题', el('span', { text: mem ? sx(mem.title) : '记忆已删除（模拟）' })),
      kv('来源类型', el('span', { text: mem && mem.source ? sx(mem.source.typeZh || mem.source.type) : '—' })),
      kv('完整哈希', mono(sx(item.hash))),
      kv('建立时间', el('span', { text: mem ? timeText(ctx, mem.createdAt) : '—' }))
    ]);
    var body = el('div', { className: 'pao-prov__modal' }, [
      steps, el('div', { className: 'pao-divider' }), meta,
      el('p', { className: 'pao-section__hint', text: '链路由本地规则生成 · 基于真实记忆库操作记录' })
    ]);
    var ui = uiOf(ctx);
    if (ui && typeof ui.modal === 'function') {
      try {
        ui.modal({ kicker: '数据溯源 · 完整链路', title: mem ? sx(mem.title) : String(memoryId), body: body, actions: [] });
        return;
      } catch (e) { /* 回落到 toast */ }
    }
    var flat = [];
    for (k = 0; k < chain.length; k++) flat.push(sx(chain[k]));
    toast('info', '完整链路', flat.length ? flat.join(' → ') : '链路数据缺失');
  }
  /* ============================ ④ 访问日志 ============================ */
  function buildAudit(ctx) {
    var filterBar = el('div', { className: 'pao-audit__bar' }), filterBtns = [];
    for (var i = 0; i < FILTERS.length; i++) {
      (function (f) {
        var b = el('button', { className: 'pao-btn pao-btn--ghost', type: 'button', text: f.zh, dataset: { act: 'filter', f: f.id } });
        filterBtns.push({ f: f.id, node: b });
        filterBar.appendChild(b);
      })(FILTERS[i]);
    }
    filterBar.appendChild(el('span', { className: 'pao-audit__spacer' }));
    filterBar.appendChild(el('button', {
      className: 'pao-btn pao-btn--primary', type: 'button', text: '导出日志', dataset: { act: 'export-audit' }
    }));
    var tbody = el('tbody');
    var table = el('table', { className: 'pao-audit' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '时间' }), el('th', { text: '操作者' }), el('th', { text: '动作' }),
        el('th', { text: '目标' }), el('th', { text: '结果' })
      ])]),
      tbody
    ]);
    var emptyNode = el('div', { className: 'pao-empty', text: '当前筛选条件下没有审计记录' });
    var wrap = el('div', { className: 'pao-audit__wrap' }, [filterBar, table, emptyNode]);
    function draw() {
      D().clear(tbody);
      var all = auditOf(ctx), shown = 0;
      for (var r = 0; r < all.length; r++) {
        var rec = all[r] || {}, res = resultOf(rec);
        if (S.auditFilter !== 'ALL' && res.key !== S.auditFilter) continue;
        shown++;
        tbody.appendChild(el('tr', { className: 'pao-audit__row', title: sx(rec.detail) }, [
          el('td', { className: 'pao-mono', text: timeText(ctx, rec.ts) }),
          el('td', { text: sx(rec.actor) }), el('td', { text: sx(rec.action) }),
          el('td', { text: sx(rec.target) }), el('td', {}, [D().badge(res.zh, res.kind)])
        ]));
      }
      table.hidden = shown === 0;
      table.style.display = shown === 0 ? 'none' : '';
      emptyNode.hidden = shown > 0;
      for (var b = 0; b < filterBtns.length; b++) {
        var active = filterBtns[b].f === S.auditFilter;
        filterBtns[b].node.className = 'pao-btn ' + (active ? 'pao-btn--primary' : 'pao-btn--ghost');
        filterBtns[b].node.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    draw();
    return { node: section('audit', '访问日志', 'Audit · 每次授权变更都会留痕', wrap), update: draw };
  }
  /* ============================ ⑤ 危险区 ============================ */
  function dangerRow(title, descNode, actionNode, extra) {
    return el('div', { className: 'pao-list__item pao-danger-row' }, [
      el('div', { className: 'pao-danger-row__main' }, [
        el('span', { className: 'pao-danger-row__title', text: title }),
        el('span', { className: 'pao-danger-row__desc' }, [descNode])
      ]),
      el('div', { className: 'pao-danger-row__act' }, [extra || null, actionNode])
    ]);
  }
  function buildDanger(ctx) {
    var clusters = ((ctx.data && ctx.data.memoryClusters) || []).length;
    var dims = ((ctx.data && ctx.data.cognitive && ctx.data.cognitive.dimensions) || []).length;
    var packFill = el('i', { className: 'pao-meter__fill' });
    packFill.style.transform = 'scaleX(0)';
    var packDesc = el('span', { text: '将把记忆在本地打包为导出压缩包，不产生任何上传行为。' });
    var delDesc = el('span', { text: '将清空记忆列表；此为本地模拟，刷新页面即恢复。' });
    var packBtn = el('button', { className: 'pao-btn pao-btn--ghost', type: 'button', text: '导出我的全部记忆', dataset: { act: 'pack' } });
    var delBtn = el('button', { className: 'pao-btn pao-btn--danger', type: 'button', text: '删除全部记忆', dataset: { act: 'delete-memories' } });
    var revokeBtn = el('button', { className: 'pao-btn pao-btn--danger', type: 'button', text: '撤销全部授权', dataset: { act: 'revoke-all' } });
    var rows = el('div', { className: 'pao-list pao-danger-zone__rows' }, [
      dangerRow('导出我的全部记忆', packDesc, packBtn, el('div', { className: 'pao-meter' }, [packFill])),
      dangerRow('删除全部记忆', delDesc, delBtn),
      dangerRow('撤销全部授权',
        el('span', { text: '所有权限回到「已撤销」，信任评分降至 0.40，并写入一条审计记录。' }), revokeBtn)
    ]);
    var slot = el('div', { className: 'pao-danger-zone__slot' });
    var body = el('div', { className: 'pao-danger-zone__body' }, [
      rows, slot,
      el('p', { className: 'pao-section__hint', text: '以上三项均只改写本地演练状态，不触达任何外部账户或云端数据。' })
    ]);
    S.refs.packFill = packFill;
    S.refs.slot = slot;
    var sec = section('danger', '数据导出与删除', '危险区 · 全部为本地模拟', body);
    sec.className += ' pao-danger-zone';
    function update() {
      var total = memoriesOf(ctx).length;
      packDesc.textContent = '将把 ' + total + ' 条记忆在本地打包为导出压缩包，不产生任何上传行为。';
      delDesc.textContent = total > 0
        ? '将删除 ' + total + ' 条记忆、' + clusters + ' 个记忆簇、' + dims + ' 个认知维度结果；此为本地模拟，刷新页面即恢复。'
        : '记忆列表当前为空（演练删除状态），30 秒后自动还原。';
    }
    return { node: sec, update: update };
  }
  function packMemories(ctx, triggerBtn) {
    if (!triggerBtn || triggerBtn.disabled) return;
    var fill = S.refs.packFill, start = Date.now();
    triggerBtn.disabled = true;
    triggerBtn.textContent = '打包中 0%';
    if (fill) fill.style.transform = 'scaleX(0)';
    var timer = every(function () {
      var p = Math.min(1, (Date.now() - start) / PACK_MS);
      if (fill) fill.style.transform = 'scaleX(' + p.toFixed(3) + ')';
      triggerBtn.textContent = '打包中 ' + Math.round(p * 100) + '%';
      if (p < 1) return;
      killTimer(timer); triggerBtn.disabled = false; triggerBtn.textContent = '导出我的全部记忆';
      writeAudit(ctx, '导出记忆包', '个人记忆库 · ' + memoriesOf(ctx).length + ' 条', 'ALLOWED', '本地打包，未上传任何数据');
      toast('ok', '导出包已生成', '已生成导出包（本地，未上传）');
      refreshAll();
    }, 60);
  }
  function performDeleteMemories(ctx) {
    var list = memoriesOf(ctx);
    if (!list.length) { toast('warn', '无需重复删除', '记忆列表已为空（模拟删除状态），30 秒后自动还原。'); return; }
    S.pendingRestore = list.slice();
    try { list.length = 0; }
    catch (e) {
      S.pendingRestore = null;
      toast('crit', '删除未执行', '当前数据结构不允许清空，数据保持不变。');
      return;
    }
    writeAudit(ctx, '删除全部记忆', '个人记忆库', 'ALLOWED', '本地模拟删除 ' + S.pendingRestore.length + ' 条记忆 · 30 秒后自动还原');
    toast('crit', '已删除（模拟）', '已清空 ' + S.pendingRestore.length + ' 条记忆 · 30 秒后自动恢复（演练）');
    refreshAll();
    later(function () { restoreMemories(ctx, false); }, RESTORE_MS);
  }
  function restoreMemories(ctx, silent) {
    if (!S.pendingRestore) return;
    var list = memoriesOf(ctx);
    try { for (var i = 0; i < S.pendingRestore.length; i++) list.push(S.pendingRestore[i]); }
    catch (e) { /* 数据不可写时保持现状 */ }
    S.pendingRestore = null;
    if (silent) return;
    writeAudit(ctx, '还原演练数据', '个人记忆库', 'ALLOWED', '定时还原 · 未触及外部数据');
    toast('ok', '演练数据已还原', '记忆列表已恢复 · 本地演练');
    refreshAll();
  }
  /* 删除：二次确认 → 输入确认词 → 执行 */
  function buildTypedPanel(ctx, impact) {
    var input = el('input', {
      className: 'pao-input', type: 'text', placeholder: '请输入：' + DELETE_WORD, 'aria-label': '确认词输入框',
      autocomplete: 'off', spellcheck: 'false'
    });
    var err = el('p', { className: 'pao-section__hint', text: '' });
    err.hidden = true;
    var confirmBtn = el('button', { className: 'pao-btn pao-btn--danger', type: 'button', text: '确认删除', disabled: 'disabled' });
    var cancelBtn = el('button', { className: 'pao-btn pao-btn--ghost', type: 'button', text: '取消' });
    var done = false, closeFn = null;
    function sync() {
      if (String(input.value || '').trim() === DELETE_WORD) confirmBtn.removeAttribute('disabled');
      else confirmBtn.setAttribute('disabled', 'disabled');
      err.hidden = true;
    }
    input.addEventListener('input', sync);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
    cancelBtn.addEventListener('click', function () { if (done) return; done = true; if (closeFn) closeFn(); });
    confirmBtn.addEventListener('click', function () {
      if (done) return;
      if (String(input.value || '').trim() !== DELETE_WORD) {
        err.hidden = false;
        err.textContent = '确认词不匹配，请输入「' + DELETE_WORD + '」。';
        return;
      }
      done = true;
      performDeleteMemories(ctx);
      if (closeFn) closeFn();
    });
    var node = el('div', { className: 'pao-danger-confirm' }, [
      el('p', { className: 'pao-danger-confirm__impact', text: impact }),
      el('p', { className: 'pao-section__hint', text: '输入完全一致的「' + DELETE_WORD + '」后，确认按钮才会生效。' }),
      input, err,
      el('div', { className: 'pao-danger-confirm__actions' }, [cancelBtn, confirmBtn])
    ]);
    return {
      node: node,
      focus: function () { try { window.setTimeout(function () { input.focus(); }, 30); } catch (e) { /* noop */ } },
      setCloser: function (fn) { closeFn = fn; }
    };
  }
  function startDelete(ctx) {
    if (S.pendingRestore) { toast('warn', '已处于演练删除状态', '数据将在倒计时结束后自动还原，无需重复删除。'); return; }
    var total = memoriesOf(ctx).length;
    var clusters = ((ctx.data && ctx.data.memoryClusters) || []).length;
    var dims = ((ctx.data && ctx.data.cognitive && ctx.data.cognitive.dimensions) || []).length;
    var impact = '将删除 ' + total + ' 条记忆、' + clusters + ' 个记忆簇、' + dims + ' 个认知维度结果；此为本地模拟，刷新页面即恢复。';
    confirmBox(ctx, {
      kicker: '危险操作', title: '确认删除全部记忆？',
      text: impact + '\n\n确认后还需输入确认词「' + DELETE_WORD + '」才会执行。',
      danger: true, confirmText: '继续'
    }).then(function (ok) { if (ok) openDeleteModal(ctx, impact); });
  }
  function openDeleteModal(ctx, impact) {
    var panel = buildTypedPanel(ctx, impact), ui = uiOf(ctx), handle = null, inline = false, opened = false;
    if (ui && typeof ui.modal === 'function') {
      try { handle = ui.modal({ kicker: '危险操作 · 二次确认', title: '删除全部记忆', body: panel.node, actions: [] }); opened = true; }
      catch (e) { opened = false; }
    }
    if (!opened && S.refs.slot) { D().clear(S.refs.slot); S.refs.slot.appendChild(panel.node); inline = true; }
    panel.setCloser(function () { closeModal(handle); if (inline && S.refs.slot) D().clear(S.refs.slot); });
    panel.focus();
  }
  function revokeAll(ctx) {
    var perms = permsOf(ctx);
    confirmBox(ctx, {
      kicker: '危险操作', title: '确认撤销全部授权？',
      text: '所有 ' + perms.length + ' 项权限将回到「已撤销」，智能体在演练中将无法调用任何外部能力；信任评分降至 0.40。此为本地演练，未影响任何外部账户。',
      danger: true, confirmText: '撤销全部'
    }).then(function (ok) {
      if (!ok) return;
      for (var i = 0; i < perms.length; i++) {
        if (!perms[i]) continue;
        perms[i].state = 'REVOKED';
        perms[i].stateZh = STATE_META.REVOKED.zh;
      }
      setScore(ctx, FLOOR_SCORE);
      writeAudit(ctx, '撤销全部授权', '全部 ' + perms.length + ' 项权限', 'ALLOWED', '本地模拟批量撤销 · 未影响任何真实账户');
      emit('trust:change', { id: 'ALL', state: 'REVOKED' });
      toast('crit', '已撤销全部授权', '评分降至 0.40 · 本地模拟，未影响任何真实授权');
      refreshAll();
    });
  }
  function exportAudit(ctx) {
    var recs = auditOf(ctx), now = new Date();
    var stamp = '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
    var json = JSON.stringify({
      product: 'PERSONAL AI OS', module: 'MODULE 06 · 权限与信任', demo: true,
      disclaimer: '本地演练数据 · 未触达外部账户', exportedAt: now.toISOString(), count: recs.length, records: recs
    }, null, 2);
    toast('warn', '演练审计数据', '导出的为本地演练审计数据');
    later(function () {
      try {
        var url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
        var a = document.createElement('a');
        a.href = url; a.download = 'pao-audit-demo-' + stamp + '.json'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        later(function () { try { URL.revokeObjectURL(url); } catch (e) { /* noop */ } }, 2000);
      } catch (e) {
        toast('crit', '导出未完成', '当前环境不支持本地下载，JSON 已输出到控制台。');
        try { console.log('[PAO 审计导出]', json); } catch (e2) { /* noop */ }
      }
    }, 400);
  }
  /* ============================ 权限切换 ============================ */
  function revokeText(p) {
    var probe = String(p.scope || '') + ' ' + String(p.target || '') + ' ' + String(p.id || '');
    if (/日历|calendar/i.test(probe)) return '撤销后，智能体将无法在你的日历中创建任何日程；已经创建的日程不受影响。';
    return '撤销后，智能体将无法再对「' + sx(p.target) + '」执行任何操作；已经产生的数据与记录不受影响。';
  }
  function grantText(p) { return '恢复后，智能体可再次在「' + sx(p.target) + '」范围内执行操作，所有调用仍会写入访问日志。'; }
  function togglePermission(ctx, id) {
    var p = findPerm(ctx, id);
    if (!p) { toast('warn', '权限不存在', '没有找到编号为 ' + id + ' 的权限项。'); return; }
    var next = stateKey(p) === 'GRANTED' ? 'REVOKED' : 'GRANTED', high = riskOf(p).level === 'HIGH';
    var locked = p.revocable === false;
    if (!(high || locked || stateKey(p) === 'PENDING')) { applyPermission(ctx, p, next); return; }
    confirmBox(ctx, {
      kicker: next === 'REVOKED' ? '撤销授权' : '恢复授权',
      title: (next === 'REVOKED' ? '确认撤销「' : '确认恢复「') + sx(p.zh || p.id) + '」授权？',
      text: (next === 'REVOKED' ? revokeText(p) : grantText(p)) + (high ? ' 该权限为高风险权限，信任评分将随之调整。' : '') +
        (locked ? ' 该项权限标记为不可撤销，此处仅演练状态变化。' : ''),
      danger: next === 'REVOKED', confirmText: next === 'REVOKED' ? '撤销授权' : '恢复授权'
    }).then(function (ok) { if (ok) applyPermission(ctx, p, next); });
  }
  function applyPermission(ctx, p, next) {
    var prev = stateKey(p);
    if (prev === next) return;
    p.state = next;
    p.stateZh = STATE_META[next] ? STATE_META[next].zh : next;
    if (next === 'GRANTED') p.lastUsed = new Date().toISOString();
    if (riskOf(p).level === 'HIGH') bumpScore(ctx, next === 'GRANTED' ? HIGH_DELTA : -HIGH_DELTA);
    writeAudit(ctx, next === 'REVOKED' ? '撤销授权' : '恢复授权',
      sx(p.zh || p.id) + (p.scope ? ' · ' + sx(p.scope) : ''), 'ALLOWED',
      '权限状态变更 ' + prev + ' → ' + next + ' · 本地模拟，未调用外部服务');
    emit('trust:change', { id: p.id, state: next });
    toast(next === 'REVOKED' ? 'warn' : 'ok', next === 'REVOKED' ? '已撤销授权' : '已恢复授权',
      sx(p.zh || p.id) + ' · ' + sx(p.stateZh) + ' · 本地模拟，未影响任何真实授权');
    if (next === 'REVOKED' && riskOf(p).level === 'HIGH') {
      toast('info', '信任评分已下调', '撤销高风险权限：评分 −' + HIGH_DELTA.toFixed(2) + '，当前 ' + scoreOf(ctx).toFixed(2) + '。');
    }
    refreshAll();
  }
  /* ============================ 事件与渲染 ============================ */
  function onClick(ev) {
    var node = findAct(ev.target);
    if (!node) return;
    var act = node.getAttribute('data-act'), ctx = S.ctx;
    if (!ctx) return;
    if (act === 'fold') { toggleFold(node); return; }
    if (act === 'perm') { togglePermission(ctx, node.getAttribute('data-id')); return; }
    if (act === 'chain') { showChain(ctx, node.getAttribute('data-id')); return; }
    if (act === 'filter') { S.auditFilter = node.getAttribute('data-f') || 'ALL'; refreshAll(); return; }
    if (act === 'export-audit') { exportAudit(ctx); return; }
    if (act === 'pack') { packMemories(ctx, node); return; }
    if (act === 'delete-memories') { startDelete(ctx); return; }
    if (act === 'revoke-all') { revokeAll(ctx); return; }
  }
  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var node = ev.target;
    if (!node || !node.getAttribute || !node.getAttribute('data-act')) return;
    ev.preventDefault();
    onClick(ev);
  }
  function refreshAll() {
    for (var i = 0; i < S.updaters.length; i++) {
      try { S.updaters[i](); } catch (e) { /* 单块刷新失败不影响其它区块 */ }
    }
  }
  function addBuilt(host, built) {
    if (!built || !built.node) return;
    host.appendChild(built.node);
    if (typeof built.update === 'function') S.updaters.push(built.update);
  }
  function render(root, ctx) {
    S.ctx = ctx; S.root = root; S.updaters = []; S.refs = {}; S.sections = {};
    D().clear(root);
    if (!trustOf(ctx)) {
      root.appendChild(el('div', {
        className: 'pao-empty', text: '信任与权限数据未就绪 · 请确认 js/data/mock-data.js 已加载后重新进入本面板'
      }));
      return;
    }
    var shell = el('div', { className: 'pao-panel pao-trust' });
    addBuilt(shell, buildRating(ctx));
    addBuilt(shell, buildPermissions(ctx));
    addBuilt(shell, buildProvenance(ctx));
    addBuilt(shell, buildAudit(ctx));
    addBuilt(shell, buildDanger(ctx));
    shell.appendChild(el('p', {
      className: 'pao-section__hint pao-trust__foot', text: '本地模拟 · 不涉及任何真实云端删除或真实授权变更'
    }));
    root.appendChild(shell);
    if (S.boundRoot !== root) {
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKey);
      S.boundRoot = root;
    }
    refreshAll();
  }
  function onEnter(ctx) {
    S.ctx = ctx;
    if (ctx && ctx.root) S.root = ctx.root;
  }
  function onExit(ctx) {
    clearTimers();
    if (S.pendingRestore) restoreMemories(ctx || S.ctx, true);
    S.updaters = [];
    if (S.refs && S.refs.slot) D().clear(S.refs.slot);
  }
  /* ============================ 注册面板 ============================ */
  PAO.panels = PAO.panels || {};
  PAO.panels['trust'] = {
    id: 'trust',
    kicker: 'MODULE 06',
    label: 'PERMISSION & TRUST',
    zh: '权限与信任',
    tagline: 'YOUR DATA. YOUR MEMORY. YOUR RULES.',
    taglineZh: '你的数据，你的记忆，你的规则。',
    badge: '本地演练',
    render: render,
    onEnter: onEnter,
    onExit: onExit
  };
})(window.PAO = window.PAO || {});
