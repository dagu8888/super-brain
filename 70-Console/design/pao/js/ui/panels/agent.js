/* PERSONAL AI OS · MODULE 03 — AGENT RUNTIME（智能体运行时）
   js/ui/panels/agent.js ｜ 契约：CONTRACT §4/§5/§6/§13、DATA.agent
   · 9 步状态机 pending → running → done；第 6 步 approve 为 waiting
   · setTimeout 链驱动，支持 暂停 / 继续 / 取消 / 重置 / 清空
   · 授权走 ctx.ui.modal；拒绝 → 该步 failed 并中止整轮；全程本地模拟，不触达外部服务 */
(function (PAO) {
  'use strict';
  var DOM = null;        // PAO.dom，render 时绑定
  var S = freshState();  // 模块级运行状态
  function freshState() {
    return {
      ctx: null, data: null, tasks: [], taskIndex: 0, task: null, defs: [], tools: [], memMap: {},
      phases: [], planned: [], spent: [], built: [], remain: 0, stepStart: 0, consumed: 0, elapsedBase: 0, elapsedStart: 0, current: -1, phase: 'idle',
      promptText: '', note: '', decision: '',
      stepTimer: null, clockTimer: null, aux: [], waitTimer: null, waitTick: null, waitSeconds: 0,
      modalOpen: false, nodes: {}, stepRefs: []
    };
  }
  /* ---------------------------------------------------------------- 小工具 */
  function el(tag, props, kids) { return DOM.el(tag, props, kids); }
  function now() { return Date.now(); }
  function pad2(n) { var v = Number(n); if (!isFinite(v)) v = 0; return v < 10 ? '0' + v : String(v); }
  function mmss(ms) {
    var t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }
  function matches(node, sel) {
    var fn = node.matches || node.msMatchesSelector || node.webkitMatchesSelector;
    if (fn) return fn.call(node, sel);
    if (sel.charAt(0) === '[' && sel.charAt(sel.length - 1) === ']') return node.hasAttribute(sel.slice(1, -1));
    return false;
  }
  function closest(node, sel) {
    while (node && node.nodeType) {
      if (node.nodeType === 1 && matches(node, sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  function emit(evt, payload) {
    var bus = (S.ctx && S.ctx.bus) || PAO.bus;
    if (bus && typeof bus.emit === 'function') bus.emit(evt, payload);
  }
  function store(patch) {
    var bus = (S.ctx && S.ctx.bus) || PAO.bus;
    if (bus && typeof bus.set === 'function') bus.set(patch);
  }
  function toast(kind, title, text) {
    var ui = (S.ctx && S.ctx.ui) || PAO.ui;
    if (ui && typeof ui.toast === 'function') ui.toast(kind, title, text);
  }
  function taskId() { return (S.task && S.task.id) || 'T-LOCAL'; }
  function stepName(i) {
    var def = S.defs[i];
    return def ? (def.zh || def.name || '步骤') + ' · ' + (def.name || '') : '未知步骤';
  }
  function emptyLine(text) { return el('div', { className: 'pao-empty', text: text }); }
  function btn(label, act, kind) {
    var node = el('button', { className: 'pao-btn' + (kind ? ' pao-btn--' + kind : ''), dataset: { act: act }, type: 'button' });
    node.textContent = label;
    return node;
  }
  function riskMeta(risk) {
    var v = String(risk == null ? '' : risk).toLowerCase();
    if (v === 'high' || v === '高' || v === '高风险') return { zh: '高风险', kind: 'crit' };
    if (v === 'medium' || v === 'mid' || v === '中' || v === '中风险') return { zh: '中风险', kind: 'warn' };
    if (v === 'low' || v === '低' || v === '低风险') return { zh: '低风险', kind: 'ok' };
    return { zh: '未标注', kind: 'muted' };
  }
  /* ---------------------------------------------------------------- 数据层 */
  function prepare(ctx) {
    var data = ctx.data || PAO.DATA || {}, agent = data.agent || {};
    S.data = data;
    S.tasks = agent.tasks || []; S.defs = agent.steps || []; S.tools = agent.tools || [];
    S.memMap = buildMemMap(data.memories || []);
    if (!S.tasks.length) { S.task = null; S.taskIndex = 0; return; }
    if (S.taskIndex >= S.tasks.length) S.taskIndex = 0;
    S.task = S.tasks[S.taskIndex] || S.tasks[0];
  }
  function buildMemMap(list) {
    var map = {};
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) map[list[i].id] = list[i];
    return map;
  }
  function taskStep(i) {
    var list = (S.task && S.task.steps) || [], def = S.defs[i] || { id: '' }, direct = list[i];
    if (direct && def.id && direct.id && direct.id !== def.id) {
      for (var k = 0; k < list.length; k++) if (list[k] && list[k].id === def.id) return list[k];
    }
    return direct || {};
  }
  function planDurations(task) {
    var out = [];
    for (var i = 0; i < S.defs.length; i++) {
      var ms = task && task.steps && task.steps[i] ? Number(task.steps[i].ms) : 0;
      if (!ms && task && task.steps) {
        for (var k = 0; k < task.steps.length; k++) {
          if (task.steps[k] && task.steps[k].id === S.defs[i].id) ms = Number(task.steps[k].ms);
        }
      }
      if (!ms || ms < 40 || ms > 20000) ms = seededMs(i);
      out.push(Math.round(ms));
    }
    return out;
  }
  /* 固定 seed：同一任务同一步骤的时长每次一致 */
  function seededMs(i) {
    var x = Math.sin((S.taskIndex + 1) * 7919 + (i + 1) * 104729) * 10000;
    return 500 + Math.round((x - Math.floor(x)) * 400);
  }
  function totalPlanned() {
    var t = 0;
    for (var i = 0; i < S.planned.length; i++) t += S.planned[i] || 0;
    return t;
  }
  function usedMemoryIds() { return (S.task && S.task.usedMemory) || []; }
  function permissions() { return (S.task && S.task.permissions) || []; }
  function preferenceCount() {
    var dims = (S.data && S.data.cognitive && S.data.cognitive.dimensions) || [];
    for (var i = 0; i < dims.length; i++) {
      if (dims[i] && dims[i].id === 'preferences') {
        if (dims[i].factors && dims[i].factors.length) return dims[i].factors.length;
        if (dims[i].evidence && dims[i].evidence.length) return dims[i].evidence.length;
      }
    }
    return 4;
  }
  /* -------------------------------------------------------------- 面板骨架 */
  function render(root, ctx) {
    teardown();
    var keep = S.taskIndex;
    S = freshState(); S.taskIndex = keep; S.ctx = ctx;
    DOM = ctx.dom || PAO.dom;
    prepare(ctx);
    var wrap = el('div', { className: 'pao-agent' });
    wrap.appendChild(buildComposer()); wrap.appendChild(buildTimeline()); wrap.appendChild(buildFooter());
    root.appendChild(wrap);
    S.nodes.wrap = wrap;
    S.phases = []; S.spent = []; S.built = [];
    for (var i = 0; i < S.defs.length; i++) { S.phases.push('pending'); S.spent.push(0); S.built.push(false); }
    S.planned = planDurations(S.task);
    buildStepList(); bindDelegates(wrap);
    updateChips(); updateMeta(); updateControls(); updateProgress(); updateElapsed();
    setAction('准备就绪。', '九步状态机待命 · 全程本地模拟。');
    renderNote();
  }
  function buildComposer() {
    var sec = el('section', { className: 'pao-section' }), head = el('div', { className: 'pao-section__head' });
    head.appendChild(el('h3', { className: 'pao-section__title', text: '任务输入' }));
    head.appendChild(el('p', { className: 'pao-section__hint', text: '描述目标，智能体会拆成九步执行；输入不会离开本机。' }));
    sec.appendChild(head);
    var ta = el('textarea', { className: 'pao-agent__input', placeholder: '描述你想让智能体完成的事…', rows: '4', spellcheck: 'false' });
    ta.value = (S.task && S.task.prompt) || '';
    sec.appendChild(ta); S.nodes.input = ta;
    var chips = el('div', { className: 'pao-agent__chips' });
    for (var i = 0; i < S.tasks.length; i++) {
      var t = S.tasks[i] || {}, chip = el('button', { className: 'pao-chip', dataset: { chip: String(i) }, type: 'button' });
      chip.textContent = t.label || t.id || ('任务 ' + (i + 1));
      chips.appendChild(chip);
    }
    if (!S.tasks.length) chips.appendChild(emptyLine('暂无预设任务 · 等待任务数据接入'));
    sec.appendChild(chips); S.nodes.chips = chips;
    var meta = el('div', { className: 'pao-kv pao-agent__meta' });
    sec.appendChild(meta); S.nodes.meta = meta;
    var actions = el('div', { className: 'pao-agent__actions' });
    sec.appendChild(actions); S.nodes.actions = actions;
    return sec;
  }
  function buildTimeline() {
    var sec = el('section', { className: 'pao-section' }), head = el('div', { className: 'pao-section__head' });
    head.appendChild(el('h3', { className: 'pao-section__title', text: '执行时间线' }));
    head.appendChild(el('p', { className: 'pao-section__hint', text: '九步状态机 · 第 6 步「等待授权」必须由你确认' }));
    sec.appendChild(head);
    var barRow = el('div', { className: 'pao-agent__bar' }), meter = el('div', { className: 'pao-meter' });
    var fill = el('span', { className: 'pao-meter__fill' });
    meter.appendChild(fill);
    var pct = el('span', { className: 'pao-num pao-agent__pct', text: '0%' });
    var clock = el('span', { className: 'pao-mono pao-agent__clock', text: '00:00' });
    barRow.appendChild(meter); barRow.appendChild(pct); barRow.appendChild(clock);
    sec.appendChild(barRow);
    S.nodes.fill = fill; S.nodes.pct = pct; S.nodes.clock = clock;
    var actionBox = el('div', { className: 'pao-agent__now' });
    actionBox.appendChild(el('span', { className: 'pao-tag', text: '当前动作' }));
    var main = el('p', { className: 'pao-agent__now-main', text: '准备就绪。' });
    var sub = el('p', { className: 'pao-agent__now-sub', text: '' });
    actionBox.appendChild(main); actionBox.appendChild(sub);
    sec.appendChild(actionBox);
    S.nodes.actionMain = main; S.nodes.actionSub = sub;
    var steps = el('div', { className: 'pao-steps' });
    sec.appendChild(steps); S.nodes.steps = steps;
    var note = el('div', { className: 'pao-agent__note' });
    sec.appendChild(note); S.nodes.note = note;
    return sec;
  }
  function buildFooter() {
    var f = el('div', { className: 'pao-agent__declaration' });
    f.appendChild(el('span', { className: 'pao-tag', text: '模拟执行' }));
    f.appendChild(el('span', { className: 'pao-agent__declaration-text', text: '本地模拟 · 未调用任何外部服务 · 未写入真实日历或邮箱' }));
    return f;
  }
  /* -------------------------------------------------------------- 时间线行 */
  function buildStepList() {
    var box = S.nodes.steps;
    S.stepRefs = [];
    if (!box) return;
    DOM.clear(box);
    if (!S.defs.length) { box.appendChild(emptyLine('时间线数据未加载 · 等待 agent.steps 接入')); return; }
    for (var i = 0; i < S.defs.length; i++) box.appendChild(buildStepRow(i));
  }
  function buildStepRow(i) {
    var def = S.defs[i] || {}, row = el('div', { className: 'pao-step is-pending', dataset: { step: String(i) } });
    var idx = el('div', { className: 'pao-step__idx' });
    idx.appendChild(el('span', { className: 'pao-num pao-step__num', text: pad2(i + 1) }));
    row.appendChild(idx);
    var main = el('div', { className: 'pao-step__main' }), head = el('div', { className: 'pao-step__head' });
    var name = el('div', { className: 'pao-step__title' });
    name.appendChild(el('span', { className: 'pao-mono pao-step__name', text: def.name || 'STEP' }));
    name.appendChild(el('span', { className: 'pao-step__zh', text: def.zh || '' }));
    head.appendChild(name);
    var meta = el('div', { className: 'pao-step__meta' });
    var icon = el('span', { className: 'pao-step__icon pao-step__icon--pending' });
    var dur = el('span', { className: 'pao-mono pao-step__dur', text: '—' });
    meta.appendChild(icon); meta.appendChild(dur); head.appendChild(meta); main.appendChild(head);
    if (def.desc) main.appendChild(el('p', { className: 'pao-step__desc', text: def.desc }));
    var body = el('div', { className: 'pao-step__body' });
    main.appendChild(body); row.appendChild(main);
    S.stepRefs[i] = { row: row, icon: icon, dur: dur, body: body, output: false };
    return row;
  }
  function updateStep(i) {
    var ref = S.stepRefs[i];
    if (!ref) return;
    var state = S.phases[i] || 'pending', cls = 'pao-step is-' + state;
    if (state === 'running' && S.phase === 'paused') cls += ' is-paused';
    ref.row.className = cls;
    DOM.clear(ref.icon);
    var iconName = state === 'done' ? 'check' : state === 'running' ? 'sync'
      : state === 'waiting' ? 'lock' : state === 'failed' ? 'warning' : '';
    if (iconName) ref.icon.appendChild(DOM.icon(iconName, 14));
    ref.icon.className = 'pao-step__icon pao-step__icon--' + state;
    var durText = '—';
    if (state === 'done') durText = (Math.max(1, S.spent[i] || 0) / 1000).toFixed(1) + ' 秒';
    else if (state === 'running') durText = '执行中';
    else if (state === 'waiting') durText = '等待授权';
    else if (state === 'failed') durText = '已终止';
    ref.dur.textContent = durText;
  }
  function updateAllSteps() { for (var i = 0; i < S.stepRefs.length; i++) updateStep(i); }
  /* ------------------------------------------------------------ 步骤内容 */
  function renderStepBody(i) {
    var ref = S.stepRefs[i];
    if (!ref) return;
    DOM.clear(ref.body);
    ref.output = false;
    var def = S.defs[i] || {}, ts = taskStep(i), extra = null;
    if (ts.detail) ref.body.appendChild(el('p', { className: 'pao-step__detail', text: ts.detail }));
    switch (def.id) {
      case 'intent': extra = buildIntent(); break;
      case 'retrieve': extra = buildRetrieve(); break;
      case 'context': extra = buildContext(); break;
      case 'plan': extra = buildPlan(); break;
      case 'perm': extra = buildPermList(); break;
      case 'approve': extra = buildApprove(); break;
      case 'execute': extra = buildExecute(); break;
      case 'verify': extra = buildVerify(); break;
      case 'done': extra = buildResult(); break;
      default: break;
    }
    if (extra) ref.body.appendChild(extra);
    S.built[i] = true;
  }
  function buildIntent() {
    var box = el('div', { className: 'pao-agent__quote' });
    box.appendChild(el('span', { className: 'pao-tag', text: '你输入的任务' }));
    box.appendChild(el('p', { className: 'pao-agent__quote-text', text: S.promptText || (S.task && S.task.prompt) || '（未填写任务描述）' }));
    var chips = (S.task && S.task.chips) || [];
    if (chips.length) {
      var row = el('div', { className: 'pao-agent__tags' });
      for (var i = 0; i < chips.length; i++) row.appendChild(el('span', { className: 'pao-tag', text: chips[i] }));
      box.appendChild(row);
    }
    return box;
  }
  function buildRetrieve() {
    var box = el('div', { className: 'pao-list' }), ids = usedMemoryIds();
    if (!ids.length) { box.appendChild(emptyLine('本次任务未调用长期记忆。')); return box; }
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], m = S.memMap[id], item = el('div', { className: 'pao-list__item pao-fade-in', style: { animationDelay: (i * 70) + 'ms' } });
      var head = el('div', { className: 'pao-list__head' });
      head.appendChild(el('span', { className: 'pao-mono pao-list__id', text: id }));
      if (m) {
        var srcType = (m.source && m.source.type) || '';
        head.appendChild(el('span', {
          className: 'pao-tag' + (srcType === 'INFERENCE' ? ' pao-tag--inference' : ''),
          text: (m.source && (m.source.typeZh || m.source.type)) || '来源未知'
        }));
        if (m.categoryZh || m.category) head.appendChild(el('span', { className: 'pao-tag', text: m.categoryZh || m.category }));
      } else head.appendChild(el('span', { className: 'pao-tag', text: '未找到该记忆' }));
      item.appendChild(head);
      item.appendChild(el('p', { className: 'pao-list__text', text: m ? (m.title || id) : '记忆库中无此编号' }));
      if (m && m.content) item.appendChild(el('p', { className: 'pao-list__sub', text: m.content }));
      box.appendChild(item);
    }
    box.appendChild(el('p', { className: 'pao-list__foot', text: '共 ' + ids.length + ' 条 · 真实记忆库' }));
    return box;
  }
  function buildContext() {
    var box = el('div', { className: 'pao-grid-2' });
    var packs = [
      { t: '记忆上下文', n: usedMemoryIds().length, d: '来自个人记忆库的事实、事件与决策' },
      { t: '偏好上下文', n: preferenceCount(), d: '来自认知引擎的偏好维度与习惯信号' },
      { t: '约束条件', n: permissions().length, d: '来自权限与信任层的范围与风险约束' }
    ];
    for (var i = 0; i < packs.length; i++) {
      var p = packs[i], card = el('div', { className: 'pao-agent__pack' }), num = el('div', { className: 'pao-agent__pack-num' });
      card.appendChild(el('span', { className: 'pao-tag', text: p.t }));
      num.appendChild(el('span', { className: 'pao-num', text: String(p.n) }));
      num.appendChild(el('span', { className: 'pao-agent__pack-unit', text: ' 条' }));
      card.appendChild(num);
      card.appendChild(el('p', { className: 'pao-agent__pack-desc', text: p.d }));
      box.appendChild(card);
    }
    return box;
  }
  function buildPlan() {
    var box = el('div', { className: 'pao-list' }), plan = (S.task && S.task.plan) || [];
    if (!plan.length) { box.appendChild(emptyLine('该任务未提供计划条目。')); return box; }
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i] || {}, item = el('div', { className: 'pao-list__item' }), head = el('div', { className: 'pao-list__head' });
      head.appendChild(el('span', { className: 'pao-mono pao-list__id', text: p.t || '—' }));
      item.appendChild(head);
      item.appendChild(el('p', { className: 'pao-list__text', text: p.d || '（未描述）' }));
      box.appendChild(item);
    }
    return box;
  }
  function buildPermList() {
    var box = el('div', { className: 'pao-list' }), perms = permissions();
    if (!perms.length) { box.appendChild(emptyLine('本次任务未申请额外权限。')); return box; }
    for (var i = 0; i < perms.length; i++) {
      var p = perms[i] || {}, rk = riskMeta(p.risk), item = el('div', { className: 'pao-list__item' }), head = el('div', { className: 'pao-list__head' });
      head.appendChild(el('span', { className: 'pao-mono pao-list__id', text: p.scope || 'scope:unknown' }));
      head.appendChild(DOM.badge(rk.zh, rk.kind));
      item.appendChild(head);
      item.appendChild(el('p', { className: 'pao-list__text', text: p.reason || '未提供申请理由。' }));
      box.appendChild(item);
    }
    return box;
  }
  function highestRisk() {
    var rank = { low: 1, medium: 2, high: 3 }, best = 'low', perms = permissions();
    for (var i = 0; i < perms.length; i++) {
      var v = String((perms[i] && perms[i].risk) || '').toLowerCase();
      if (v === '高' || v === '高风险') v = 'high';
      if (v === '中' || v === '中风险') v = 'medium';
      if (v === '低' || v === '低风险') v = 'low';
      if ((rank[v] || 0) > (rank[best] || 0)) best = v;
    }
    return riskMeta(best);
  }
  function buildApprove() {
    var card = el('div', { className: 'pao-agent__approve' });
    card.appendChild(el('p', { className: 'pao-agent__approve-lead', text: '智能体请求执行以下操作：' }));
    card.appendChild(buildPermList());
    var riskRow = el('div', { className: 'pao-agent__approve-risk' });
    riskRow.appendChild(el('span', { className: 'pao-agent__approve-risk-k', text: '综合风险' }));
    var rk = highestRisk();
    riskRow.appendChild(DOM.badge(rk.zh, rk.kind));
    card.appendChild(riskRow);
    card.appendChild(el('p', { className: 'pao-agent__disclaimer', text: '本地模拟 · 不会真正写入你的日历' }));
    var actions = el('div', { className: 'pao-agent__approve-actions' });
    if (S.phase === 'waiting') {
      actions.appendChild(btn('拒绝', 'deny', 'ghost'));
      actions.appendChild(btn('授权并继续', 'grant', 'primary'));
    } else {
      var decided = '等待授权';
      if (S.decision === 'granted') decided = '已授权 · 模拟继续';
      else if (S.decision === 'denied') decided = '已拒绝 · 任务终止';
      actions.appendChild(el('span', { className: 'pao-tag', text: decided }));
    }
    card.appendChild(actions);
    return card;
  }
  function findTool(pool, key) {
    var needle = String(key == null ? '' : key).toLowerCase();
    for (var i = 0; i < pool.length; i++) {
      var t = pool[i] || {};
      if (String(t.id || '').toLowerCase() === needle || String(t.name || '').toLowerCase() === needle) return t;
    }
    return null;
  }
  function findToolByScope(pool, scope) {
    var needle = String(scope == null ? '' : scope).toLowerCase();
    for (var i = 0; i < pool.length; i++) {
      var t = pool[i] || {};
      if (String(t.scope || '').toLowerCase() === needle || String(t.id || '').toLowerCase() === needle) return t;
    }
    return null;
  }
  function resolveTools() {
    var pool = S.tools || [], picked = [], declared = (S.task && S.task.tools) || null;
    if (declared && declared.length) {
      for (var d = 0; d < declared.length; d++) {
        var key = declared[d];
        if (typeof key === 'string') picked.push(findTool(pool, key) || { name: key, zh: '自定义工具', risk: 'low' });
        else if (key && (key.name || key.id)) picked.push(findTool(pool, key.id || key.name) || key);
      }
      if (picked.length) return picked;
    }
    var perms = permissions();
    for (var i = 0; i < perms.length; i++) {
      var hit = findToolByScope(pool, perms[i] && perms[i].scope);
      if (hit && picked.indexOf(hit) === -1) picked.push(hit);
    }
    if (!picked.length) picked = pool.slice(0, 3);
    return picked;
  }
  function buildExecute() {
    var box = el('div', { className: 'pao-list' }), tools = resolveTools(), ms = S.planned[S.current] || 800;
    if (!tools.length) { box.appendChild(emptyLine('未解析到工具调用，本次执行仅做计划推演。')); return box; }
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i] || {}, rk = riskMeta(t.risk), item = el('div', { className: 'pao-list__item' }), head = el('div', { className: 'pao-list__head' });
      head.appendChild(el('span', { className: 'pao-mono pao-list__id', text: t.name || t.id || 'TOOL' }));
      head.appendChild(el('span', { className: 'pao-tag', text: '模拟执行' }));
      head.appendChild(DOM.badge(rk.zh, rk.kind));
      item.appendChild(head);
      if (t.zh) item.appendChild(el('p', { className: 'pao-list__text', text: t.zh }));
      if (t.scope) item.appendChild(el('p', { className: 'pao-list__sub pao-mono', text: String(t.scope) }));
      var meter = el('div', { className: 'pao-meter pao-meter--slim' }), fill = el('span', { className: 'pao-meter__fill' });
      meter.appendChild(fill); item.appendChild(meter);
      animateFill(fill, ms);
      box.appendChild(item);
    }
    return box;
  }
  function animateFill(fill, ms) {
    fill.style.transform = 'scaleX(0.02)';
    fill.style.transition = 'transform ' + Math.max(240, ms) + 'ms linear';
    addAux(setTimeout(function () { fill.style.transform = 'scaleX(1)'; }, 40));
  }
  function buildVerify() {
    var box = el('div', { className: 'pao-list' }), verify = (S.task && S.task.result && S.task.result.verify) || {};
    var checks = verify.checks || [];
    if (!checks.length) { box.appendChild(emptyLine('未提供验证项。')); return box; }
    var passed = 0;
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i], label = c, ok = true;
      if (c && typeof c === 'object') {
        label = c.label || c.zh || c.text || ('检查项 ' + (i + 1));
        ok = c.pass !== false && c.ok !== false && c.passed !== false;
      }
      if (ok) passed += 1;
      var item = el('div', { className: 'pao-list__item pao-list__item--inline' });
      item.appendChild(DOM.icon(ok ? 'check' : 'warning', 14));
      item.appendChild(el('span', { className: 'pao-list__text', text: String(label) }));
      box.appendChild(item);
    }
    var total = checks.length, claimed = Number(verify.passed);
    var shown = isFinite(claimed) && claimed >= 0 ? Math.min(claimed, total) : passed;
    box.appendChild(el('p', { className: 'pao-list__foot', text: '验证通过 ' + shown + '/' + total + ' 项 · 本地模拟' }));
    return box;
  }
  function buildResult() {
    var res = (S.task && S.task.result) || {}, card = el('div', { className: 'pao-agent__result' });
    var head = el('div', { className: 'pao-agent__result-head' });
    head.appendChild(el('span', { className: 'pao-tag', text: '模拟结果' }));
    head.appendChild(el('h4', { className: 'pao-agent__result-title', text: res.title || '任务完成' }));
    card.appendChild(head);
    card.appendChild(el('p', { className: 'pao-agent__result-summary', text: res.summary || '本次执行全部为本地模拟，未产生任何外部写入。' }));
    var items = res.items || [];
    if (items.length) {
      var list = el('div', { className: 'pao-list' });
      for (var i = 0; i < items.length; i++) {
        var row = el('div', { className: 'pao-list__item pao-list__item--inline' });
        row.appendChild(DOM.icon('check', 14));
        row.appendChild(el('span', { className: 'pao-list__text', text: String(items[i]) }));
        list.appendChild(row);
      }
      card.appendChild(list);
    }
    var verify = res.verify || {};
    if (verify.checks && verify.checks.length) {
      card.appendChild(el('p', {
        className: 'pao-list__foot',
        text: '验证 ' + (verify.passed != null ? verify.passed : verify.checks.length) + '/' + verify.checks.length + ' 项通过 · 本地演练'
      }));
    }
    var actions = el('div', { className: 'pao-agent__result-actions' });
    actions.appendChild(btn('查看执行记录', 'audit', 'ghost'));
    actions.appendChild(btn('重置任务', 'reset', 'primary'));
    card.appendChild(actions);
    return card;
  }
  function markOutput(i) {
    var ref = S.stepRefs[i];
    if (!ref || ref.output) return;
    var ts = taskStep(i);
    if (!ts.output) return;
    var out = el('p', { className: 'pao-step__out' });
    out.appendChild(el('span', { className: 'pao-tag', text: '输出' }));
    out.appendChild(el('span', { className: 'pao-step__out-text', text: ts.output }));
    ref.body.appendChild(out);
    ref.output = true;
  }
  function appendFail(i, text) {
    var ref = S.stepRefs[i];
    if (!ref) return;
    var box = el('div', { className: 'pao-danger-zone' });
    box.appendChild(el('p', { className: 'pao-danger-zone__text', text: text }));
    ref.body.appendChild(box);
  }
  /* -------------------------------------------------------------- 控件状态 */
  function updateControls() {
    var box = S.nodes.actions;
    if (!box) return;
    DOM.clear(box);
    var groups = {
      running: [['暂停', 'pause', 'ghost'], ['取消', 'cancel', 'danger']],
      paused: [['继续', 'resume', 'primary'], ['取消', 'cancel', 'danger']],
      done: [['重新执行', 'start', 'primary'], ['清空', 'clear', 'ghost']],
      failed: [['重新执行', 'start', 'primary'], ['重置任务', 'reset', 'ghost']],
      cancelled: [['重新执行', 'start', 'primary'], ['重置任务', 'reset', 'ghost']],
      idle: [['开始执行', 'start', 'primary'], ['清空', 'clear', 'ghost']]
    };
    if (S.phase === 'waiting') {
      box.appendChild(el('span', { className: 'pao-tag pao-agent__wait-tag', text: '等待授权中' }));
      box.appendChild(btn('取消', 'cancel', 'danger'));
    } else {
      var set = groups[S.phase] || groups.idle;
      for (var i = 0; i < set.length; i++) box.appendChild(btn(set[i][0], set[i][1], set[i][2]));
    }
    var locked = S.phase === 'running' || S.phase === 'paused' || S.phase === 'waiting';
    if (S.nodes.input) S.nodes.input.disabled = locked;
    if (S.nodes.chips) {
      var buttons = S.nodes.chips.getElementsByTagName('button');
      for (var k = 0; k < buttons.length; k++) buttons[k].disabled = locked;
    }
  }
  function setAction(main, sub) {
    if (S.nodes.actionMain) S.nodes.actionMain.textContent = main || '—';
    if (S.nodes.actionSub) S.nodes.actionSub.textContent = sub || '';
  }
  function updateChips() {
    if (!S.nodes.chips) return;
    var buttons = S.nodes.chips.getElementsByTagName('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].className = Number(buttons[i].getAttribute('data-chip')) === S.taskIndex ? 'pao-chip is-active' : 'pao-chip';
    }
  }
  function addKV(box, k, v) {
    var row = el('div', { className: 'pao-kv__item' });
    row.appendChild(el('span', { className: 'pao-kv__k', text: k }));
    row.appendChild(el('span', { className: 'pao-kv__v', text: v }));
    box.appendChild(row);
  }
  function updateMeta() {
    var box = S.nodes.meta;
    if (!box) return;
    DOM.clear(box);
    addKV(box, '执行步骤', S.defs.length + ' 步');
    addKV(box, '预计时长', '约 ' + Math.max(1, Math.round(totalPlanned() / 1000)) + ' 秒');
    addKV(box, '调用记忆', usedMemoryIds().length + ' 条');
    addKV(box, '权限申请', permissions().length + ' 项');
    addKV(box, '运行方式', '本地模拟');
  }
  function updateProgress() {
    var total = totalPlanned(), acc = S.consumed, cur = S.current;
    if (cur >= 0 && S.phases[cur] === 'running' && S.planned[cur]) acc += Math.max(0, S.planned[cur] - S.remain);
    var p = total > 0 ? Math.max(0, Math.min(1, acc / total)) : 0;
    if (S.phase === 'done') p = 1;
    if (S.nodes.fill) S.nodes.fill.style.transform = 'scaleX(' + p + ')';
    if (S.nodes.pct) S.nodes.pct.textContent = Math.round(p * 100) + '%';
  }
  function updateElapsed() {
    if (!S.nodes.clock) return;
    S.nodes.clock.textContent = mmss(S.elapsedBase + (S.elapsedStart ? now() - S.elapsedStart : 0));
  }
  function renderNote() {
    var box = S.nodes.note;
    if (!box) return;
    DOM.clear(box);
    if (!S.note) { box.className = 'pao-agent__note'; return; }
    box.className = 'pao-agent__note is-on';
    var kind = S.phase === 'failed' ? '已中止' : S.phase === 'done' ? '已完成' : '提示';
    box.appendChild(el('span', { className: 'pao-tag', text: kind }));
    box.appendChild(el('span', { className: 'pao-agent__note-text', text: S.note }));
  }
  /* ---------------------------------------------------------------- 计时器 */
  function addAux(id) { S.aux.push(id); return id; }
  function clearAux() {
    for (var i = 0; i < S.aux.length; i++) clearTimeout(S.aux[i]);
    S.aux = [];
  }
  function clearStepTimer() { if (S.stepTimer) { clearTimeout(S.stepTimer); S.stepTimer = null; } }
  function startClock() {
    stopClockTimerOnly();
    S.elapsedStart = now();
    S.clockTimer = setInterval(function () { updateElapsed(); }, 200);
    updateElapsed();
  }
  function stopClockTimerOnly() { if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; } }
  function stopClock() {
    stopClockTimerOnly();
    if (S.elapsedStart) { S.elapsedBase += now() - S.elapsedStart; S.elapsedStart = 0; }
    updateElapsed();
  }
  function teardown() { clearStepTimer(); stopClock(); clearAux(); stopWaitHint(); }
  /* ---------------------------------------------------------------- 执行流 */
  function start() {
    if (!S.task) { toast('warn', '暂无任务', '任务数据尚未加载，无法开始执行。'); return; }
    if (S.phase === 'running' || S.phase === 'paused' || S.phase === 'waiting') return;
    teardown();
    S.promptText = S.nodes.input ? S.nodes.input.value : '';
    S.planned = planDurations(S.task);
    S.current = -1; S.consumed = 0; S.elapsedBase = 0; S.elapsedStart = 0;
    S.remain = 0; S.decision = ''; S.note = ''; S.waitSeconds = 0;
    for (var i = 0; i < S.defs.length; i++) {
      S.phases[i] = 'pending'; S.spent[i] = 0; S.built[i] = false;
      if (S.stepRefs[i]) { DOM.clear(S.stepRefs[i].body); S.stepRefs[i].output = false; updateStep(i); }
    }
    renderNote(); updateMeta(); updateProgress(); updateElapsed();
    S.phase = 'running';
    updateControls();
    setAction('正在提交任务…', '九步状态机已启动 · 本地模拟');
    startClock();
    store({ agentRunning: true, agentTask: taskId() });
    beginStep(0);
  }
  function beginStep(i) {
    if (S.phase === 'cancelled' || S.phase === 'failed') return;
    if (i >= S.defs.length) { finishRun(); return; }
    S.current = i;
    var def = S.defs[i] || {}, approve = def.id === 'approve';
    S.phases[i] = approve ? 'waiting' : 'running';
    if (approve) { S.phase = 'waiting'; updateControls(); }
    S.remain = S.planned[i] || 600;
    emit('agent:step', { taskId: taskId(), index: i, state: S.phases[i] });
    renderStepBody(i); updateStep(i); updateProgress();
    setAction(actionFor(i), stepHint(i));
    if (approve) { openApprove(i); return; }
    scheduleStep();
  }
  function scheduleStep() {
    clearStepTimer();
    S.stepStart = now();
    S.stepTimer = setTimeout(function () { S.stepTimer = null; completeStep(); }, Math.max(80, S.remain));
  }
  function completeStep() {
    var i = S.current;
    if (i < 0 || !S.defs[i]) return;
    clearStepTimer();
    var spent = Math.round((S.planned[i] || 0) - Math.max(0, S.remain));
    if (spent <= 0 || spent > (S.planned[i] || 0)) spent = S.planned[i] || 600;
    S.spent[i] = spent; S.consumed += spent; S.phases[i] = 'done'; S.remain = 0;
    emit('agent:step', { taskId: taskId(), index: i, state: 'done' });
    updateStep(i); markOutput(i); updateProgress();
    var next = i + 1;
    if (next >= S.defs.length) { finishRun(); return; }
    beginStep(next);
  }
  function finishRun() {
    clearStepTimer(); clearAux(); stopClock();
    S.phase = 'done';
    S.note = '执行完成 · 结果仅用于本地演练，未写入外部数据。';
    setAction('任务完成。', '九步全部为本地模拟 · 未调用任何外部服务');
    updateAllSteps(); renderNote(); updateControls(); updateProgress(); updateElapsed();
    store({ agentRunning: false });
    emit('agent:done', { taskId: taskId() });
    toast('ok', '执行完成', '九步时间线全部为本地模拟。');
  }
  function pause() {
    if (S.phase !== 'running') return;
    clearStepTimer();
    S.remain = Math.max(0, S.remain - (now() - S.stepStart));
    stopClock();
    S.phase = 'paused';
    updateStep(S.current); updateControls();
    setAction('已暂停 · 剩余约 ' + Math.max(1, Math.round(S.remain / 1000)) + ' 秒', '计时已冻结，继续后从断点接续');
    toast('info', '已暂停', '时间线停在「' + stepName(S.current) + '」。');
  }
  function resume() {
    if (S.phase !== 'paused') return;
    S.phase = 'running';
    updateStep(S.current); updateControls(); startClock();
    setAction(actionFor(S.current), '从断点继续执行');
    scheduleStep();
    toast('info', '已继续', '从「' + stepName(S.current) + '」继续执行。');
  }
  function cancel() {
    if (S.phase !== 'running' && S.phase !== 'paused' && S.phase !== 'waiting') return;
    clearStepTimer(); clearAux(); stopClock(); stopWaitHint();
    var i = S.current;
    if (i >= 0) {
      S.phases[i] = 'failed';
      emit('agent:step', { taskId: taskId(), index: i, state: 'failed' });
      renderStepBody(i); appendFail(i, '你取消了任务，执行在此处中止。'); updateStep(i);
    }
    S.phase = 'cancelled';
    S.note = '已取消 · 未产生任何外部写入（本地模拟）。';
    setAction('任务已取消。', '你可以重置任务后重新开始');
    renderNote(); updateControls(); updateProgress(); updateElapsed();
    store({ agentRunning: false });
    emit('agent:done', { taskId: taskId(), cancelled: true });
    toast('warn', '已取消', '任务在「' + stepName(i) + '」中止。');
  }
  function resetRun(silent) {
    teardown();
    S.current = -1; S.consumed = 0; S.elapsedBase = 0; S.elapsedStart = 0;
    S.remain = 0; S.decision = ''; S.note = ''; S.promptText = ''; S.waitSeconds = 0;
    S.phase = 'idle';
    for (var i = 0; i < S.phases.length; i++) {
      S.phases[i] = 'pending'; S.spent[i] = 0;
      if (S.stepRefs[i]) { DOM.clear(S.stepRefs[i].body); S.stepRefs[i].output = false; updateStep(i); }
    }
    if (S.nodes.input) S.nodes.input.value = (S.task && S.task.prompt) || '';
    renderNote(); updateControls(); updateProgress(); updateElapsed();
    setAction('准备就绪。', '点击「开始执行」启动九步状态机。');
    store({ agentRunning: false });
    if (!silent) toast('info', '已重置', '时间线与计时回到初始状态。');
  }
  function clearAll() {
    if (S.phase === 'running' || S.phase === 'paused' || S.phase === 'waiting') {
      toast('warn', '任务进行中', '请先取消当前执行，再清空。');
      return;
    }
    if (S.tasks.length) {
      S.taskIndex = 0; S.task = S.tasks[0]; S.planned = planDurations(S.task);
      if (S.nodes.input) S.nodes.input.value = S.task.prompt || '';
      updateChips(); updateMeta();
    }
    resetRun(true);
    toast('info', '已清空', '回到初始任务与初始状态。');
  }
  function selectTask(i) {
    if (S.phase === 'running' || S.phase === 'paused' || S.phase === 'waiting') {
      toast('warn', '执行中不可切换', '请先取消当前任务。');
      return;
    }
    var task = S.tasks[i];
    if (!task) return;
    S.taskIndex = i; S.task = task; S.planned = planDurations(task);
    if (S.nodes.input) S.nodes.input.value = task.prompt || '';
    updateChips(); updateMeta(); resetRun(true);
    toast('info', '已切换任务', (task.label || task.id) + ' · 本地模拟');
  }
  function showAudit() {
    var audit = ((S.data && S.data.trust) || {}).audit || [];
    toast('info', '执行记录', '共 ' + audit.length + ' 条审计条目（本地演练记录）。');
  }
  /* ---------------------------------------------------------------- 文案表 */
  function actionFor(i) {
    var def = S.defs[i] || {};
    switch (def.id) {
      case 'intent': return '正在理解你的意图…';
      case 'retrieve': return '正在检索 ' + usedMemoryIds().length + ' 条相关记忆…';
      case 'context': return '正在构建 3 个上下文包…';
      case 'plan': return '正在编排执行计划…';
      case 'perm': return '正在核对 ' + permissions().length + ' 项权限申请…';
      case 'approve': return '等待你的授权…';
      case 'execute': return '正在模拟执行 ' + resolveTools().length + ' 个工具调用…';
      case 'verify': return '正在逐条验证结果…';
      case 'done': return '正在整理结果摘要…';
      default: return '准备中…';
    }
  }
  function stepHint(i) {
    var def = S.defs[i] || {};
    switch (def.id) {
      case 'intent': return '解析目标、约束与期望产出';
      case 'retrieve': return '从个人记忆库读取相关条目';
      case 'context': return '把记忆、偏好与约束打包成上下文';
      case 'plan': return '拆解为可执行的步骤与时间点';
      case 'perm': return '列出需要你知情的权限范围';
      case 'approve': return '第 6 步 · 需要你明确授权';
      case 'execute': return '逐项模拟工具调用，不发生真实写入';
      case 'verify': return '对照预期逐条自检';
      case 'done': return '汇总结果与验证状态';
      default: return '';
    }
  }
  /* ---------------------------------------------------------------- 授权流 */
  function openApprove(i) {
    startWaitHint();
    if (S.modalOpen) return;
    var ui = S.ctx && S.ctx.ui;
    if (!ui || typeof ui.modal !== 'function') {
      S.note = '确认框不可用，请在步骤卡片内直接授权或拒绝。';
      renderNote();
      return;
    }
    var body = el('div', { className: 'pao-agent__modal' });
    body.appendChild(el('p', { className: 'pao-agent__modal-lead', text: '智能体请求执行以下操作：' }));
    body.appendChild(buildPermList());
    var riskRow = el('div', { className: 'pao-agent__modal-risk' });
    riskRow.appendChild(el('span', { className: 'pao-agent__modal-risk-k', text: '综合风险' }));
    var rk = highestRisk();
    riskRow.appendChild(DOM.badge(rk.zh, rk.kind));
    body.appendChild(riskRow);
    body.appendChild(el('p', { className: 'pao-agent__disclaimer', text: '本地模拟 · 不会真正写入你的日历' }));
    var acted = false;
    var onDeny = function () { if (acted) return; acted = true; S.modalOpen = false; deny(); };
    var onGrant = function () { if (acted) return; acted = true; S.modalOpen = false; grant(); };
    S.modalOpen = true;
    try {
      ui.modal({
        kicker: 'MODULE 03 · AGENT RUNTIME',
        title: '需要你的授权',
        body: body,
        actions: [
          { text: '拒绝', label: '拒绝', kind: 'ghost', variant: 'ghost', onClick: onDeny, fn: onDeny, handler: onDeny },
          { text: '授权并继续', label: '授权并继续', kind: 'primary', variant: 'primary', primary: true, onClick: onGrant, fn: onGrant, handler: onGrant }
        ],
        dismissible: true
      });
    } catch (err) {
      S.modalOpen = false;
      S.note = '确认框未能打开，请在步骤卡片内直接授权或拒绝。';
      renderNote();
    }
  }
  function grant() {
    if (S.phase !== 'waiting') return;
    var i = S.current;
    S.decision = 'granted';
    stopWaitHint();
    S.phase = 'running';
    renderStepBody(i); updateControls(); updateStep(i);
    setAction('已授权 · 继续执行…', '授权范围仅在本地模拟中生效');
    completeStep();
    toast('ok', '已授权', '继续执行后续步骤（本地模拟）。');
  }
  function deny() {
    if (S.phase !== 'waiting') return;
    var i = S.current;
    S.decision = 'denied';
    stopWaitHint(); clearStepTimer(); clearAux(); stopClock();
    S.phases[i] = 'failed';
    emit('agent:step', { taskId: taskId(), index: i, state: 'failed' });
    renderStepBody(i); appendFail(i, '你拒绝了授权，任务已终止。'); updateStep(i);
    S.phase = 'failed';
    S.note = '你拒绝了授权，任务已终止。未执行任何写入（本地模拟）。';
    setAction('任务已终止。', '授权被拒绝，后续步骤未执行');
    renderNote(); updateControls(); updateProgress(); updateElapsed();
    store({ agentRunning: false });
    emit('agent:done', { taskId: taskId(), denied: true });
    toast('warn', '已拒绝', '任务在授权确认处终止。');
  }
  function startWaitHint() {
    stopWaitHint();
    S.waitSeconds = 0;
    S.waitTimer = setTimeout(function () {
      S.waitTimer = null;
      S.waitSeconds = 15;
      setAction('等待你的授权…', '已等待 15 秒 · 任务保持挂起，不会自动执行');
      S.waitTick = setInterval(function () {
        S.waitSeconds += 1;
        setAction('等待你的授权…', '已等待 ' + S.waitSeconds + ' 秒 · 任务保持挂起，不会自动执行');
      }, 1000);
    }, 15000);
  }
  function stopWaitHint() {
    if (S.waitTimer) { clearTimeout(S.waitTimer); S.waitTimer = null; }
    if (S.waitTick) { clearInterval(S.waitTick); S.waitTick = null; }
  }
  /* -------------------------------------------------------------- 事件委托 */
  function bindDelegates(wrap) {
    wrap.addEventListener('click', function (ev) {
      var chip = closest(ev.target, '[data-chip]');
      if (chip) { selectTask(Number(chip.getAttribute('data-chip'))); return; }
      var node = closest(ev.target, '[data-act]');
      if (!node) return;
      switch (node.getAttribute('data-act')) {
        case 'start': start(); break;
        case 'pause': pause(); break;
        case 'resume': resume(); break;
        case 'cancel': cancel(); break;
        case 'reset': resetRun(); break;
        case 'clear': clearAll(); break;
        case 'audit': showAudit(); break;
        case 'grant': grant(); break;
        case 'deny': deny(); break;
        default: break;
      }
    });
  }
  /* ---------------------------------------------------------------- 注册 */
  PAO.panels = PAO.panels || {};
  PAO.panels['agent'] = {
    id: 'agent',
    kicker: 'MODULE 03',
    label: 'AGENT RUNTIME',
    zh: '智能体运行时',
    tagline: 'FROM INTELLIGENCE TO ACTION.',
    taglineZh: '从理解，到行动。',
    badge: '本地模拟',
    render: render,
    onEnter: function (ctx) { S.ctx = ctx; },
    onExit: function () { teardown(); S.modalOpen = false; }
  };
})(window.PAO = window.PAO || {});
