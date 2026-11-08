/* ==========================================================================
 * js/ui/concierge.js — 私人管家 Dock（原生 ES5 / IIFE / window.PAO）
 * 依赖（缺失时降级）：PAO.dom / PAO.bus / PAO.net / PAO.ui
 * 职责：dock DOM 注入 / SSE 对话 / 执行卡 / 任务卡 / 数字人头像 / 模式徽标 / 历史恢复
 * ========================================================================== */
(function (global) {
  'use strict';
  var DOC = global.document;
  var PAO = global.PAO || (global.PAO = {});
  var WELCOME_TEXT = '早上好。我是你的私人管家。直接告诉我你想做什么——我会拆解任务、分派 Agent，并在三维空间里实时执行给你看。';
  var HISTORY_HINT = '以下是历史对话';
  var CHIPS = ['整理本周工作', '研究黄金宏观走势', '我还说过什么'];
  var HISTORY_LIMIT = 6;
  var TASK_TTL = 60000;
  var TASK_FADE = 420;
  var MAX_ACTS = 8;
  var CONCIERGE_ID = 'agent_concierge';
  var AGENT_COLOR = { idle: '#7E8999', thinking: '#55DDF5', running: '#91DFFF', completed: '#5FD6A8', failed: '#E06767' };
  var AGENT_LABEL = { idle: '待命', thinking: '思考中', running: '执行中', completed: '已完成', failed: '异常' };
  var ACTION_LABEL = {
    create_task: '创建任务', spawn_agent: '分派 Agent', delegate: '分派 Agent', search_memory: '检索记忆',
    remember: '写入记忆', run_skill: '调用技能', plan: '拆解计划', tool_call: '调用工具',
    web_search: '联网检索', notify: '推送通知'
  };
  /* ---------------- 模块内状态 ---------------- */
  var S = {
    root: null, capsule: null, avatar: null, ctx: null, stateText: null, dot: null, badge: null,
    panel: null, mode: null, msgs: null, tasks: null, textarea: null, sendBtn: null, collapseBtn: null,
    typing: null, bubble: null, acts: [], conversationId: null, busy: false, interrupted: false,
    controller: null, unread: 0, modelMode: 'offline', taskMap: {}, taskOrder: [], taskSeq: 0,
    timers: [], cleanups: [], rafId: 0, color: AGENT_COLOR.idle, historyDone: false, gone: false
  };
  /* ---------------- 通用小工具 ---------------- */
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  /* 优先 PAO.dom.el，缺失时用等价的最小实现兜底 */
  function el(tag, props, children) {
    if (PAO.dom && typeof PAO.dom.el === 'function') { return PAO.dom.el(tag, props, children); }
    var node = DOC.createElement(tag);
    var k;
    props = props || {};
    if (props.className) { node.className = props.className; }
    if (props.text !== undefined && props.text !== null) { node.textContent = String(props.text); }
    if (props.attrs) { for (k in props.attrs) { if (has(props.attrs, k)) { node.setAttribute(k, String(props.attrs[k])); } } }
    if (props.dataset) { for (k in props.dataset) { if (has(props.dataset, k)) { node.setAttribute('data-' + k, String(props.dataset[k])); } } }
    if (props.on) { for (k in props.on) { if (has(props.on, k)) { node.addEventListener(k, props.on[k]); } } }
    if (children && children.length) { for (k = 0; k < children.length; k++) { if (children[k]) { node.appendChild(children[k]); } } }
    return node;
  }
  function bind(node, type, fn, opts) {
    if (!node || !node.addEventListener) { return; }
    var cap = opts || false;
    node.addEventListener(type, fn, cap);
    S.cleanups.push(function () { node.removeEventListener(type, fn, cap); });
  }
  function subscribe(src, event, fn) {
    if (!src || typeof src.on !== 'function') { return; }
    var off = src.on(event, fn);
    if (typeof off === 'function') { S.cleanups.push(off); }
  }
  function listenBus(event, fn) { subscribe(PAO.bus, event, fn); }
  function listenNet(event, fn) { subscribe(PAO.net, event, fn); }
  function later(fn, ms) {
    var id = global.setTimeout(function () {
      var ix = S.timers.indexOf(id);
      if (ix >= 0) { S.timers.splice(ix, 1); }
      if (!S.gone) { fn(); }
    }, ms);
    S.timers.push(id);
    return id;
  }
  function toast(kind, title, text) {
    if (!PAO.ui || typeof PAO.ui.toast !== 'function') { return; }
    try { PAO.ui.toast(kind, title, text); } catch (e) { /* 无 UI 层时静默 */ }
  }
  function isOnline() { return !!(PAO.net && PAO.net.state === 'online'); }
  function clock(iso) {
    var d, hh, mm;
    try {
      if (PAO.dom && PAO.dom.fmt && typeof PAO.dom.fmt.time === 'function') { return PAO.dom.fmt.time(iso || new Date().toISOString()); }
    } catch (e) { /* 落到本地格式化 */ }
    d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) { d = new Date(); }
    hh = d.getHours(); mm = d.getMinutes();
    return (hh < 10 ? '0' + hh : String(hh)) + ':' + (mm < 10 ? '0' + mm : String(mm));
  }
  function fetchJSON(url) {
    return global.fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res || !res.ok) { throw new Error('HTTP ' + (res ? res.status : '0')); }
      return res.json();
    });
  }
  /* ---------------- DOM 注入 ---------------- */
  function build() {
    var root = el('div', { className: 'pao-dock is-collapsed', attrs: { id: 'pao-dock' } });
    var avatar = el('canvas', { className: 'pao-dock__avatar', attrs: { width: '60', height: '60' } });
    var stateText = el('span', { className: 'pao-dock__state', text: '待命' });
    var meta = el('div', { className: 'pao-dock__meta' }, [el('span', { className: 'pao-dock__name', text: '私人管家' }), stateText]);
    var dot = el('i', { className: 'pao-dock__dot' });
    var badge = el('span', { className: 'pao-dock__badge', text: '0' });
    badge.hidden = true;
    var capsule = el('div', { className: 'pao-dock__capsule' }, [avatar, meta, dot, badge]);
    var title = el('span', { className: 'pao-dock__title', text: '私人管家 · CONCIERGE' });
    var mode = el('span', { className: 'pao-dock__mode', text: '后端离线', dataset: { mode: 'offline' } });
    var collapseBtn = el('button', { className: 'pao-dock__collapse', attrs: { type: 'button', 'aria-label': '收起' }, text: '×' });
    var head = el('header', { className: 'pao-dock__head' }, [title, mode, collapseBtn]);
    var msgs = el('div', { className: 'pao-dock__msgs' });
    var tasks = el('div', { className: 'pao-dock__tasks' });
    var chips = el('div', { className: 'pao-dock__chips' });
    var i;
    for (i = 0; i < CHIPS.length; i++) { chips.appendChild(el('button', { className: 'pao-dock__chip', attrs: { type: 'button' }, text: CHIPS[i] })); }
    var textarea = el('textarea', { className: 'pao-dock__textarea', attrs: { placeholder: '告诉我你想做什么…', rows: '1' } });
    var sendBtn = el('button', { className: 'pao-dock__send', attrs: { type: 'button' }, text: '发送' });
    var inputRow = el('div', { className: 'pao-dock__input' }, [textarea, sendBtn]);
    var panel = el('div', { className: 'pao-dock__panel' }, [head, msgs, tasks, chips, inputRow]);
    root.appendChild(capsule);
    root.appendChild(panel);
    if (DOC.body) { DOC.body.appendChild(root); }
    S.root = root; S.capsule = capsule; S.avatar = avatar; S.stateText = stateText;
    S.dot = dot; S.badge = badge; S.panel = panel; S.mode = mode; S.collapseBtn = collapseBtn;
    S.msgs = msgs; S.tasks = tasks; S.textarea = textarea; S.sendBtn = sendBtn;
    bind(capsule, 'click', function () { toggleDock(); });
    bind(collapseBtn, 'click', function (ev) { if (ev && ev.preventDefault) { ev.preventDefault(); } closeDock(); });
    bind(sendBtn, 'click', function () { if (S.busy) { abortRun(); } else { send(); } });
    bind(textarea, 'keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
    });
    bind(textarea, 'input', autosize);
    for (i = 0; i < chips.childNodes.length; i++) {
      (function (btn) {
        bind(btn, 'click', function () {
          if (!isOnline() || S.busy) { return; }
          if (S.textarea) { S.textarea.value = btn.textContent || ''; }
          autosize();
          send();
        });
      })(chips.childNodes[i]);
    }
  }
  /* ---------------- 消息流 ---------------- */
  function scrollBottom() { if (S.msgs) { S.msgs.scrollTop = S.msgs.scrollHeight; } }
  function setUnread(n) {
    S.unread = n < 0 ? 0 : n;
    if (!S.badge) { return; }
    if (S.unread > 0) { S.badge.textContent = S.unread > 99 ? '99+' : String(S.unread); S.badge.hidden = false; }
    else { S.badge.textContent = '0'; S.badge.hidden = true; }
  }
  function noteIncoming() { if (S.root && S.root.className.indexOf('is-collapsed') >= 0) { setUnread(S.unread + 1); } }
  function appendMsg(kind, text, ts) {
    if (!S.msgs) { return null; }
    var body = text === undefined || text === null ? '' : String(text);
    var bubble = el('div', { className: 'pao-msg__bubble', text: body });
    var node = el('div', { className: 'pao-msg pao-msg--' + (kind || 'assistant') }, [bubble]);
    if (kind !== 'system') { node.appendChild(el('div', { className: 'pao-msg__meta', text: clock(ts) })); }
    S.msgs.appendChild(node); scrollBottom();
    return bubble;
  }
  function appendStatus(text, isError) {
    if (!S.msgs) { return; }
    var node = el('div', { className: 'pao-msg__status', text: text === undefined || text === null ? '' : String(text) });
    if (isError) { node.classList.add('is-error'); }
    S.msgs.appendChild(node); scrollBottom();
  }
  function dropTyping() { if (S.typing && S.typing.parentNode) { S.typing.parentNode.removeChild(S.typing); } S.typing = null; }
  function showTyping() {
    dropTyping();
    if (!S.msgs) { return; }
    S.typing = el('div', { className: 'pao-msg pao-msg--assistant pao-typing' }, [el('div', { className: 'pao-msg__status', text: '正在思考…' })]);
    S.msgs.appendChild(S.typing); scrollBottom();
  }
  function ensureBubble() { dropTyping(); if (!S.bubble) { S.bubble = appendMsg('assistant', ''); } return S.bubble; }
  /* ---------------- 执行卡 ---------------- */
  function appendAction(action) {
    if (!action || !S.msgs) { return; }
    var type = action.type ? String(action.type) : '';
    var label = action.label || action.title || action.name || ACTION_LABEL[type] || type || '执行操作';
    var card = el('div', { className: 'pao-act' }, [
      el('i', { className: 'pao-act__icon' }),
      el('span', { className: 'pao-act__text', text: String(label) }),
      el('span', { className: 'pao-act__state', text: '进行中' })
    ]);
    card.setAttribute('data-action', type);
    S.msgs.appendChild(card);
    S.acts.push({ el: card, type: type, done: false });
    if (S.acts.length > MAX_ACTS) { S.acts.shift(); }
    scrollBottom();
  }
  function completeAction(action) {
    var type = action && action.type ? String(action.type) : '';
    for (var i = 0; i < S.acts.length; i++) {
      var rec = S.acts[i];
      if (rec.done || (type && rec.type && rec.type !== type)) { continue; }
      rec.done = true;
      rec.el.classList.add('is-done');
      var stateEl = rec.el.querySelector('.pao-act__state');
      if (stateEl) { stateEl.textContent = '完成'; }
      return;
    }
  }
  /* ---------------- 任务卡 ---------------- */
  function taskOf(payload) {
    var id = '';
    if (payload) {
      if (payload.taskId) { id = String(payload.taskId); }
      else if (payload.id) { id = String(payload.id); }
      else if (payload.task && payload.task.id) { id = String(payload.task.id); }
    }
    if (!id) { id = 'anon_' + (S.taskSeq++); }
    var t = S.taskMap[id];
    if (!t) {
      t = {
        id: id, progress: 0, steps: [], status: 'running', runningIndex: -1, fade: false,
        title: String((payload && (payload.title || (payload.task && payload.task.title))) || '任务')
      };
      S.taskMap[id] = t;
      S.taskOrder.push(id);
    }
    return t;
  }
  function pushStep(t, name) {
    if (!name) { return -1; }
    var label = String(name);
    var ix = t.steps.indexOf(label);
    if (ix >= 0) { return ix; }
    t.steps.push(label);
    return t.steps.length - 1;
  }
  function onTaskCreated(payload) {
    var t = taskOf(payload);
    if (payload.title) { t.title = String(payload.title); }
    if (payload.steps && payload.steps.length) {
      t.steps = [];
      for (var i = 0; i < payload.steps.length; i++) { pushStep(t, payload.steps[i]); }
    }
    if (payload.step) { pushStep(t, payload.step); }
    t.status = 'running'; t.fade = false;
    if (typeof payload.progress === 'number') { t.progress = payload.progress; }
    renderTasks();
  }
  function onTaskProgress(payload) {
    var t = taskOf(payload);
    if (typeof payload.progress === 'number') { t.progress = payload.progress > 0 && payload.progress <= 1 ? payload.progress * 100 : payload.progress; }
    if (payload.step) {
      var ix = pushStep(t, payload.step);
      if (typeof payload.stepIndex !== 'number') { t.runningIndex = ix; }
    }
    if (typeof payload.stepIndex === 'number') { t.runningIndex = payload.stepIndex; }
    if (t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled') { t.status = 'running'; }
    renderTasks();
  }
  function onTaskEnd(payload, status) {
    var t = taskOf(payload);
    t.status = status;
    if (status === 'completed') { t.progress = 100; t.runningIndex = t.steps.length; }
    renderTasks();
    scheduleTaskRemoval(t.id);
  }
  function scheduleTaskRemoval(id) {
    later(function () {
      var t = S.taskMap[id];
      if (!t) { return; }
      t.fade = true;
      renderTasks();
      later(function () {
        delete S.taskMap[id];
        var ix = S.taskOrder.indexOf(id);
        if (ix >= 0) { S.taskOrder.splice(ix, 1); }
        renderTasks();
      }, TASK_FADE);
    }, TASK_TTL);
  }
  function taskStatusText(t) {
    if (t.status === 'completed') { return '已完成'; }
    if (t.status === 'failed') { return '失败'; }
    if (t.status === 'cancelled') { return '已取消'; }
    return '执行中 ' + Math.round(t.progress || 0) + '%';
  }
  function taskCard(t) {
    var head = el('div', { className: 'pao-taskcard__head' }, [
      el('span', { className: 'pao-taskcard__title', text: String(t.title || '任务') }),
      el('span', { className: 'pao-taskcard__status', text: taskStatusText(t) })
    ]);
    var list = el('ol', { className: 'pao-taskcard__steps' });
    var settled = t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed';
    var i, cls;
    for (i = 0; i < t.steps.length; i++) {
      cls = 'pao-taskstep';
      if (settled || (t.runningIndex >= 0 && i < t.runningIndex)) { cls += ' is-done'; }
      else if (i === t.runningIndex) { cls += ' is-running'; }
      else { cls += ' is-pending'; }
      list.appendChild(el('li', { className: cls, text: String(t.steps[i]) }));
    }
    var fill = el('i', { className: 'pao-taskcard__fill' });
    fill.style.width = Math.max(0, Math.min(100, t.progress || 0)) + '%';
    var meter = el('div', { className: 'pao-taskcard__meter' }, [fill]);
    var card = el('div', { className: 'pao-taskcard' }, [head, list, meter]);
    if (t.fade) { card.style.opacity = '0'; card.style.transition = 'opacity 0.4s ease'; }
    return card;
  }
  function renderTasks() {
    if (!S.tasks) { return; }
    while (S.tasks.firstChild) { S.tasks.removeChild(S.tasks.firstChild); }
    var ids = S.taskOrder.slice(-2);
    for (var i = 0; i < ids.length; i++) { if (S.taskMap[ids[i]]) { S.tasks.appendChild(taskCard(S.taskMap[ids[i]])); } }
    scrollBottom();
  }
  /* ---------------- 数字人头像（Canvas 2D 60×60） ---------------- */
  function drawArc(ctx, cx, cy, r, a0, a1, color, width, alpha) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke(); ctx.restore();
  }
  function drawAvatar(ts) {
    var ctx = S.ctx;
    var w, h, cx, cy, R, breathe, rot, r2;
    if (!ctx || !S.avatar) { return; }
    w = S.avatar.width; h = S.avatar.height; cx = w / 2; cy = h / 2; R = w / 2 - 1;
    breathe = 0.5 + 0.5 * Math.sin(ts / 1800);
    rot = (ts / 2600) % (Math.PI * 2);
    ctx.clearRect(0, 0, w, h);
    var bg = ctx.createRadialGradient(cx, cy, 2, cx, cy, R);
    bg.addColorStop(0, 'rgba(18,52,64,0.98)'); bg.addColorStop(0.58, 'rgba(8,28,36,0.98)'); bg.addColorStop(1, 'rgba(2,10,14,1)');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
    ctx.lineCap = 'round';
    drawArc(ctx, cx, cy, R * 0.74, -Math.PI * 0.82 + breathe * 0.12, -Math.PI * 0.08, S.color, 2, 0.92);
    drawArc(ctx, cx, cy, R * 0.54, rot, rot + Math.PI * 0.92, '#55DDF5', 1.6, 0.78);
    drawArc(ctx, cx, cy, R * 0.37, -rot * 1.7, -rot * 1.7 + Math.PI * 0.56, '#91DFFF', 1.2, 0.52);
    r2 = R * (0.1 + 0.035 * breathe);
    var core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r2 * 3.2);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.35, 'rgba(140,235,255,' + (0.55 + 0.25 * breathe).toFixed(2) + ')');
    core.addColorStop(1, 'rgba(85,221,245,0)');
    ctx.beginPath(); ctx.arc(cx, cy, r2 * 3.2, 0, Math.PI * 2); ctx.fillStyle = core; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(235,252,255,0.95)'; ctx.fill();
  }
  function frame(ts) {
    if (S.gone) { return; }
    S.rafId = global.requestAnimationFrame(frame);
    if (!DOC.hidden) { drawAvatar(ts || 0); }
  }
  function startAvatar() {
    if (S.avatar && typeof S.avatar.getContext === 'function') { S.ctx = S.avatar.getContext('2d'); }
    bind(DOC, 'visibilitychange', function () {
      if (!DOC.hidden) { drawAvatar(typeof global.performance !== 'undefined' ? global.performance.now() : Date.now()); }
    });
    if (!S.ctx) { return; }
    if (typeof global.requestAnimationFrame === 'function') { S.rafId = global.requestAnimationFrame(frame); } else { drawAvatar(0); }
  }
  function setAgentStatus(status) {
    var key = status && AGENT_COLOR[status] ? status : 'idle';
    S.color = AGENT_COLOR[key];
    if (S.stateText) { S.stateText.textContent = AGENT_LABEL[key] || '待命'; }
  }
  /* ---------------- 模式徽标 / 连接态 ---------------- */
  function setModeAttr(mode, label) { if (!S.mode) { return; } S.mode.setAttribute('data-mode', mode); S.mode.textContent = label; }
  function applyMode() {
    if (!S.mode) { return; }
    if (!isOnline()) { setModeAttr('offline', '后端离线'); return; }
    if (S.modelMode === 'live') { setModeAttr('live', '模型在线'); } else { setModeAttr('local-plan', '本地规划'); }
  }
  function setDisabled(flag) { if (S.textarea) { S.textarea.disabled = !!flag; } if (S.sendBtn) { S.sendBtn.disabled = !!flag; } }
  function updateConnection() {
    var on = isOnline();
    setDisabled(!on);
    if (S.textarea) { S.textarea.setAttribute('placeholder', on ? '告诉我你想做什么…' : '后端未连接（npm start）'); }
    applyMode();
  }
  function refreshMode() {
    fetchJSON('/api/models/status').then(function (data) {
      var st = data && data.status ? data.status : null;
      if (!st) { return; }
      S.modelMode = st.mode === 'live' ? 'live' : 'local-plan';
      applyMode();
    }).catch(function () { applyMode(); });
  }
  /* ---------------- 历史恢复 ---------------- */
  function loadHistory() {
    if (S.historyDone) { return; }
    S.historyDone = true;
    fetchJSON('/api/conversations').then(function (data) {
      var list = data && data.conversations ? data.conversations : null;
      if (!list || !list.length || !list[0] || !list[0].id) { return null; }
      S.conversationId = String(list[0].id);
      return fetchJSON('/api/conversations/detail?id=' + encodeURIComponent(list[0].id)).then(function (detail) {
        var conv = detail && detail.conversation ? detail.conversation : null;
        var msgs = conv && conv.messages ? conv.messages : null;
        if (!msgs || !msgs.length) { return; }
        appendMsg('system', HISTORY_HINT);
        for (var i = Math.max(0, msgs.length - HISTORY_LIMIT); i < msgs.length; i++) {
          var m = msgs[i] || {};
          var role = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'assistant');
          appendMsg(role, m.content === undefined || m.content === null ? '' : m.content, m.ts);
        }
        setUnread(0);
      });
    }).catch(function () { appendStatus('历史对话读取失败', true); });
  }
  /* ---------------- SSE 帧派发 ---------------- */
  function handleFrame(f) {
    var type = f.type ? String(f.type) : '';
    if (type === 'meta') {
      if (f.conversationId) { S.conversationId = String(f.conversationId); }
      if (f.mode === 'live') { S.modelMode = 'live'; } else if (f.mode === 'local-plan') { S.modelMode = 'local-plan'; }
      applyMode();
      return;
    }
    if (type === 'status') { appendStatus(f.text, false); return; }
    if (type === 'delta') {
      var b = ensureBubble();
      b.textContent = b.textContent + (f.text === undefined || f.text === null ? '' : String(f.text));
      noteIncoming(); scrollBottom(); return;
    }
    if (type === 'reply_text') {
      var b2 = ensureBubble();
      if (!b2.textContent) { b2.textContent = f.text === undefined || f.text === null ? '' : String(f.text); }
      noteIncoming(); scrollBottom(); return;
    }
    if (type === 'action') { appendAction(f.action || f); return; }
    if (type === 'action_result') { completeAction(f.action || f); return; }
    if (type === 'error') { appendStatus(f.text || '发生错误', true); return; }
    if (type === 'done' || type === 'end') {
      if (f.mode === 'live') { S.modelMode = 'live'; } else if (f.mode === 'local-plan') { S.modelMode = 'local-plan'; }
      applyMode();
      finishRun(false);
    }
  }
  function handleBlock(block) {
    var lines = String(block).split(/\r?\n/);
    var data = [];
    var i, raw, parsed = null;
    for (i = 0; i < lines.length; i++) { if (lines[i].indexOf('data:') === 0) { data.push(lines[i].slice(5).replace(/^\s/, '')); } }
    if (!data.length) { return; }
    raw = data.join('\n');
    if (raw === '[DONE]') { return; }
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (parsed) { handleFrame(parsed); }
  }
  function parseBuffer(text) {
    var blocks = String(text || '').split('\n\n');
    for (var i = 0; i < blocks.length; i++) { if (blocks[i] && blocks[i].replace(/\s/g, '')) { handleBlock(blocks[i]); } }
  }
  /* fetch + reader 手动切帧（空行分界），不使用 EventSource */
  function consumeStream(body) {
    var reader = body.getReader();
    var decoder = typeof global.TextDecoder === 'function' ? new global.TextDecoder('utf-8') : null;
    var buffer = '';
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk && chunk.done) { if (buffer) { parseBuffer(buffer); buffer = ''; } return null; }
        buffer += decoder ? decoder.decode(chunk.value, { stream: true }) : String.fromCharCode.apply(null, chunk.value);
        var cut = buffer.indexOf('\n\n');
        while (cut >= 0) { handleBlock(buffer.slice(0, cut)); buffer = buffer.slice(cut + 2); cut = buffer.indexOf('\n\n'); }
        return pump();
      });
    }
    return pump();
  }
  /* ---------------- 发送 / 中断 ---------------- */
  function setBusy(flag) {
    S.busy = !!flag;
    if (S.root) { S.root.classList[flag ? 'add' : 'remove']('is-busy'); }
    if (S.panel) { S.panel.classList[flag ? 'add' : 'remove']('is-busy'); }
    if (S.sendBtn) {
      S.sendBtn.textContent = flag ? '停止' : '发送';
      S.sendBtn.classList[flag ? 'add' : 'remove']('is-stop');
    }
  }
  function finishRun(failed) {
    dropTyping();
    if (!S.busy) { return; }
    setBusy(false);
    S.controller = null;
    setDisabled(!isOnline());
    if (S.bubble && !S.bubble.textContent && !failed) { S.bubble.textContent = '（没有返回内容）'; }
    S.bubble = null; S.interrupted = false;
    scrollBottom();
  }
  function abortRun() { if (!S.controller) { return; } S.interrupted = true; try { S.controller.abort(); } catch (e) { /* 已结束 */ } }
  function send(raw) {
    if (S.busy) { return; }
    if (!isOnline()) {
      appendStatus('后端未连接（npm start）', true);
      toast('warning', '后端未连接', '请先执行 npm start');
      return;
    }
    var text = raw === undefined || raw === null ? (S.textarea ? S.textarea.value : '') : String(raw);
    text = String(text).replace(/^\s+|\s+$/g, '');
    if (!text) { return; }
    if (S.textarea) { S.textarea.value = ''; }
    autosize();
    appendMsg('user', text);
    openDock();
    S.bubble = appendMsg('assistant', '');
    showTyping();
    setBusy(true);
    S.interrupted = false;
    var ctrl = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    S.controller = ctrl;
    var init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId: S.conversationId || null, message: text })
    };
    if (ctrl) { init.signal = ctrl.signal; }
    global.fetch('/api/chat', init).then(function (res) {
      if (!res || !res.ok) { throw new Error('HTTP ' + (res ? res.status : '0')); }
      if (res.body && typeof res.body.getReader === 'function') { return consumeStream(res.body); }
      return res.text().then(function (full) { parseBuffer(full); });
    }).then(function () {
      finishRun(false);
    }).catch(function (err) {
      if (S.interrupted || (err && (err.name === 'AbortError' || err.code === 20))) {
        if (S.bubble) { S.bubble.textContent = S.bubble.textContent + '（已中断）'; }
        finishRun(true);
        return;
      }
      appendStatus('请求失败：' + (err && err.message ? err.message : '未知错误'), true);
      toast('error', '请求失败', '无法连接到后端服务');
      finishRun(true);
    });
  }
  /* ---------------- 交互细节 ---------------- */
  function autosize() {
    var ta = S.textarea;
    if (!ta) { return; }
    ta.style.height = 'auto';
    var h = ta.scrollHeight;
    if (!h || isNaN(h)) { h = 24; }
    ta.style.height = (h > 96 ? 96 : h) + 'px';
    ta.style.overflowY = h > 96 ? 'auto' : 'hidden';
  }
  function openDock() {
    if (!S.root) { return; }
    S.root.classList.remove('is-collapsed');
    setUnread(0);
    scrollBottom();
    if (S.textarea && !S.textarea.disabled) { try { S.textarea.focus(); } catch (e) { /* 忽略 */ } }
  }
  function closeDock() { if (S.root) { S.root.classList.add('is-collapsed'); } }
  function toggleDock() { if (!S.root) { return; } if (S.root.className.indexOf('is-collapsed') >= 0) { openDock(); } else { closeDock(); } }
  function onBusState(state) {
    if (!S.root) { return; }
    var active = state && state.activeModule ? String(state.activeModule) : '';
    var shifted = S.root.className.indexOf('is-shifted') >= 0;
    if (active && active !== 'concierge') {
      if (!shifted) { S.root.classList.add('is-shifted'); }
    } else if (shifted) { S.root.classList.remove('is-shifted'); }
  }
  /* ---------------- 订阅 ---------------- */
  function bindNetEvents() {
    listenNet('agent.status.changed', function (p) {
      if (!p) { return; }
      if (p.agentId && p.agentId !== CONCIERGE_ID) { return; }
      setAgentStatus(p.to || p.status || 'idle');
    });
    listenNet('task.created', function (p) { onTaskCreated(p || {}); });
    listenNet('task.progress', function (p) { onTaskProgress(p || {}); });
    listenNet('task.completed', function (p) { onTaskEnd(p || {}, 'completed'); });
    listenNet('task.failed', function (p) { onTaskEnd(p || {}, 'failed'); });
    listenNet('task.cancelled', function (p) { onTaskEnd(p || {}, 'cancelled'); });
  }
  function bindBusEvents() {
    listenBus('srv:online', function () { updateConnection(); refreshMode(); loadHistory(); });
    listenBus('srv:offline', function () { updateConnection(); });
    listenBus('state', function (state) { onBusState(state); });
  }
  /* ---------------- 生命周期 ---------------- */
  function init() {
    if (S.root || S.gone) { return; }
    build();
    setAgentStatus('idle');
    startAvatar();
    updateConnection();
    appendMsg('system', WELCOME_TEXT);
    bindNetEvents();
    bindBusEvents();
    autosize();
    if (PAO.bus && PAO.bus.store) { onBusState(PAO.bus.store); }
    refreshMode();
    if (isOnline()) { loadHistory(); }
  }
  function destroy() {
    if (S.gone) { return; }
    S.gone = true;
    if (S.controller) { try { S.controller.abort(); } catch (e) { /* 已结束 */ } S.controller = null; }
    for (var i = 0; i < S.timers.length; i++) { global.clearTimeout(S.timers[i]); }
    S.timers.length = 0;
    for (i = 0; i < S.cleanups.length; i++) { try { S.cleanups[i](); } catch (e2) { /* 忽略 */ } }
    S.cleanups.length = 0;
    if (S.rafId && typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(S.rafId); }
    S.rafId = 0;
    if (S.root && S.root.parentNode) { S.root.parentNode.removeChild(S.root); }
    S.root = null; S.msgs = null; S.tasks = null; S.textarea = null; S.sendBtn = null;
    S.typing = null; S.bubble = null; S.acts = []; S.taskMap = {}; S.taskOrder = [];
  }
  PAO.concierge = {
    open: openDock,
    close: closeDock,
    toggle: toggleDock,
    send: function (text) { send(text); },
    destroy: destroy
  };
  if (DOC.readyState === 'loading') { DOC.addEventListener('DOMContentLoaded', init, false); }
  else { init(); }
})(window);
