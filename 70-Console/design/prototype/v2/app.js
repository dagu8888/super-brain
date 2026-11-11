/* Super-Brain 协作中枢 v2（查看免口令；写操作需配对本设备）
   数据源：/api/dashboard（KPI/异常/点名/消息）、/api/server（服务器健康）、/api/relations、
          /api/agents/{id}、/api/messages?agent=、/api/tasks/{id}、/api/knowledge、/api/stream（SSE）。
   纪律：在线只认心跳/在场信号；“执行中”只认任务租约；粒子只在真实消息/事件到达时出现；
        数字只在两次真实取数之间过渡，不编数据。不需要口令，也不保存任何口令。 */
"use strict";
(function () {
  const API = location.protocol.startsWith("http") ? "" : "https://console.8.218.106.225.nip.io";
  const HUB = "__hub__";
  const OFFLINE_S = 300;
  const TZ = "Asia/Shanghai";
  const ROLE = {
    "knowledge-worker": "知识整理", "archive-worker": "归档", "research-worker": "研究",
    "analysis-worker": "分析", "chat-worker": "对话", "code-worker": "代码",
    "trae-developer": "开发", "test-agent-worker": "测试",
  };
  const CHIEF_NAME = { "grok-chief": "幕僚长", "deepseek-chief": "DeepSeek", "muse-chief": "Muse", "trae-chief": "Trae" };
  const LIVE = { working: "执行中", idle: "在线", offline: "离线", unused: "未接入", disabled: "已暂停" };
  const OWNER = "dagu-owner";
  const CHAT_PEER = "grok-chief";
  const TASK = { pending: "待办", doing: "执行中", done: "已完成", failed: "失败", dead: "死信", cancelled: "已取消" };

  const mql = (q) => window.matchMedia(q);
  const reduced = mql("(prefers-reduced-motion: reduce)");
  const mobile = mql("(max-width: 760px)");

  const S = {
    dash: null, server: null, relations: [], skew: 0,
    feed: [], seenIds: new Set(), lastMsgTs: 0, lastEvtTs: 0,
    feedFilter: "all", agentFilter: "all",
    es: null, esFails: 0, esTimer: null, pollTimer: null, mode: "idle",
    graph: null, view: null, viewKind: null, prevKpi: {}, selected: null,
    instMap: {}, agentById: {}, lastActivity: 0, kbQ: "",
    chat: [], chatIds: new Set(), chatNames: new Set([CHAT_PEER]), chatReply: null, chatUnread: 0, chatHook: null,
    projects: [], apPrev: null,
  };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => Math.floor(Date.now() / 1000) + S.skew;
  const fmtT = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fmtDT = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtD = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const tm = (ts) => (ts ? fmtT.format(new Date(ts * 1000)) : "—");
  const dtm = (ts) => (ts ? fmtDT.format(new Date(ts * 1000)) : "—");
  const ago = (ts) => {
    if (!ts) return "从未";
    const d = Math.max(0, now() - ts);
    if (d < 60) return d + " 秒前";
    if (d < 3600) return Math.floor(d / 60) + " 分钟前";
    if (d < 86400) return Math.floor(d / 3600) + " 小时前";
    return Math.floor(d / 86400) + " 天前";
  };
  const dur = (s) => {
    if (s == null) return "—";
    if (s < 60) return s + " 秒";
    if (s < 3600) return Math.floor(s / 60) + " 分";
    if (s < 86400) return Math.floor(s / 3600) + " 小时 " + Math.floor((s % 3600) / 60) + " 分";
    return Math.floor(s / 86400) + " 天 " + Math.floor((s % 86400) / 3600) + " 小时";
  };
  const lat = (s) => (s == null ? "—" : s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "分" : (s / 3600).toFixed(1) + "时");
  const big = (n) => (n == null ? "—" : n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 1 : 2) + "万" : String(n));

  async function api(path, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(API + path, { signal: ctl.signal, cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
      if (j.ts) S.skew = j.ts - Math.floor(Date.now() / 1000);
      return j;
    } finally { clearTimeout(t); }
  }
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2600);
  }

  /* ---------- 名称与语义 ---------- */
  function agentName(id) {
    if (id === HUB) return "中台";
    if (id === OWNER) return "大古";
    if (!id) return "—";
    if (id === "all") return "全体";
    const a = S.agentById[id];
    if (a) return a._label;
    if (S.instMap[id]) return id.split("@")[0];
    return id;
  }
  function labelOf(a) {
    if (a.kind === "chief") {
      if (CHIEF_NAME[a.agent_id]) return CHIEF_NAME[a.agent_id];
      const inst = (a.instances || [])[0];
      if (inst && inst.name) return inst.name.split("@")[0];
      return a.agent_id.replace(/-chief$/, "").toUpperCase();
    }
    return ROLE[a.agent_id] || a.agent_id.replace(/-worker$/, "");
  }
  const whoCls = (id) => (id === HUB || id === OWNER ? "h" : (S.agentById[id] || {}).kind === "worker" ? "w" : "c");
  const toAgent = (name) => (S.agentById[name] ? name : S.instMap[name] || null);
  const liveOf = (a) => (a.status !== "active" ? "disabled" : a.live_status);
  const span = (s) => (s == null ? "" : s < 3600 ? Math.max(1, Math.floor(s / 60)) + " 分钟" : s < 86400 ? Math.floor(s / 3600) + " 小时" : Math.floor(s / 86400) + " 天");
  /* 细分状态：离线 X 天/小时（按最近在场）· 空闲 X 分钟 · 忙碌（在做什么：自报或任务租约）· 已暂停 · 未接入。
     忙碌只认 /cmd work 自报或任务租约，心跳只证明在线。 */
  function stateOf(a) {
    const st = a.state || {};
    const t = now();
    switch (st.state) {
      case "paused": return { k: "paused", cls: "disabled", text: "已暂停" };
      case "unused": return { k: "unused", cls: "unused", text: "未接入" };
      case "offline": return { k: "offline", cls: "offline", text: st.since ? "离线 " + span(t - st.since) : "离线" };
      case "busy": return { k: "busy", cls: "busy", text: "忙碌", work: st.work, src: st.work_source, since: st.since };
      case "idle": return { k: "idle", cls: "idle", text: st.idle_since ? "空闲 " + span(t - st.idle_since) : "空闲" };
      default: { const lv = liveOf(a); return { k: lv, cls: lv, text: LIVE[lv] }; }
    }
  }
  const stateLine = (a) => { const s = stateOf(a); return s.k === "busy" && s.work ? s.text + " · " + s.work : s.text; };

  /* ---------- 连接状态 ---------- */
  function setConn(mode, text) {
    S.mode = mode;
    const el = $("#conn");
    el.dataset.s = mode === "live" ? "live" : mode === "down" ? "bad" : mode === "idle" ? "idle" : "warn";
    el.querySelector("b").textContent = text;
    if (S.dash) renderTicker();
  }

  /* ---------- 取数 ---------- */
  async function loadDash(first) {
    try {
      const j = await api("/api/dashboard");
      ingestDash(j.data, first);
    } catch (e) {
      if (first) $("#kpis").innerHTML = `<div class="kpi" style="grid-column:1/-1"><div class="k-label">取数失败</div><div class="k-sub">${esc(e.message)} · 10 秒后重试</div></div>`;
      setTimeout(() => loadDash(first), 10000);
    }
  }
  async function loadServer() {
    try { S.server = (await api("/api/server")).data; renderServer(); renderKpis(); }
    catch (e) { $("#health-pill").dataset.s = "bad"; $("#health-pill b").textContent = "健康数据不可用"; }
  }
  async function loadRelations() {
    try { S.relations = (await api("/api/relations")).data || []; if (S.dash) buildGraph(); } catch (e) { /* 关系为可选增强 */ }
  }
  async function loadEvents() {
    try {
      const j = await api("/api/events?limit=40");
      (j.data || []).forEach((e) => addFeed(evtItem(e), false));
      S.lastEvtTs = Math.max(S.lastEvtTs, ...(j.data || []).map((e) => e.created_at || 0), 0);
      renderFeed();
    } catch (e) { /* 事件流为可选增强 */ }
  }

  function ingestDash(d, first) {
    S.dash = d;
    S.skew = d.now - Math.floor(Date.now() / 1000);
    S.agentById = {}; S.instMap = {};
    d.agents.forEach((a) => {
      a._label = labelOf(a);
      S.agentById[a.agent_id] = a;
      (a.instances || []).forEach((i) => { S.instMap[i.name] = a.agent_id; });
    });
    const recent = d.messages.recent || [];
    recent.forEach((m) => addFeed(msgItem(m), false));
    S.lastMsgTs = Math.max(S.lastMsgTs, ...recent.map((m) => m.created_at || 0), 0);
    S.lastActivity = Math.max(S.lastActivity, S.lastMsgTs);
    renderKpis(); renderRollcalls(); renderAgents(); renderFeed(); buildGraph(); renderTicker(); renderChatFoot();
    if (first) { startStream(); }
  }

  /* ---------- 消息流 ---------- */
  function msgItem(m) {
    const k = m.kind === "ping" ? "ping" : "msg";
    return { id: m.msg_id, k, ts: m.created_at, from: m.from_agent, fromInst: m.from_instance, to: m.to, text: m.text, kind: m.kind, reply: m.reply_to, thread: m.thread_id, raw: m };
  }
  function evtItem(e) {
    const alert = /lost|fail|dead|timeout|alert|error/i.test(e.type || "");
    return { id: e.event_id, k: alert ? "alert" : "event", ts: e.created_at, from: e.source, to: HUB, text: e.type + (e.status ? " · " + e.status : ""), kind: e.type, raw: e };
  }
  function addFeed(it, live) {
    if (S.seenIds.has(it.id)) return false;
    S.seenIds.add(it.id);
    it.fresh = !!live;
    S.feed.push(it);
    S.feed.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (S.feed.length > 300) { S.feed.length = 300; }
    return true;
  }
  function feedRow(it) {
    const dup = it.k !== "event" && it.reply && S.dash && isDuplicateReply(it);
    const to = it.to === HUB ? "" : `<span class="arrow">→</span><span class="who ${whoCls(toAgent(it.to) || it.to)}">${esc(agentName(toAgent(it.to) || it.to))}</span>`;
    const from = toAgent(it.from) || it.from;
    const tag = it.k === "ping" ? '<span class="tag ping">点名</span>'
      : it.k === "event" ? `<span class="tag">事件</span>` : it.k === "alert" ? '<span class="tag red">告警事件</span>'
      : it.reply ? '<span class="tag">回复</span>' : '<span class="tag">消息</span>';
    return `<li class="fi${it.fresh && !reduced.matches ? " fresh" : ""}" data-k="${it.k}" data-id="${esc(it.id)}" tabindex="0">
      <div class="fi-top"><time>${tm(it.ts)}</time><span class="who ${whoCls(from)}">${esc(agentName(from))}</span>${it.fromInst ? `<span class="arrow">·${esc(it.fromInst.split("@")[1] || "")}</span>` : ""}${to}${tag}${dup ? '<span class="tag dup">重复回复</span>' : ""}</div>
      <div class="fi-text">${esc(it.k === "event" || it.k === "alert" ? it.text : (it.text || "").slice(0, 300))}</div></li>`;
  }
  function isDuplicateReply(it) {
    const firsts = new Set();
    for (const r of S.dash.rollcalls || []) {
      if (r.msg_id !== it.reply) continue;
      (r.replies || []).forEach((x) => firsts.add(x.created_at + "|" + (x.from_instance || x.from_agent)));
      return !firsts.has(it.ts + "|" + (it.fromInst || it.from));
    }
    return false;
  }
  function renderFeed() {
    const f = S.feedFilter;
    const items = S.feed.filter((it) => f === "all" || (f === "msg" && it.k === "msg") || (f === "ping" && it.k === "ping") || (f === "event" && (it.k === "event" || it.k === "alert"))).slice(0, 120);
    $("#feed").innerHTML = items.length ? items.map(feedRow).join("")
      : '<li class="empty"><b>暂无记录</b>筛选条件下没有消息；新消息到达会自动出现在这里</li>';
    S.feed.forEach((it) => { it.fresh = false; });
  }

  /* ---------- SSE 实时 ---------- */
  function startStream() {
    if (!("EventSource" in window)) { startPolling(); return; }
    clearTimeout(S.esTimer);
    if (S.es) { try { S.es.close(); } catch (e) { /* noop */ } }
    const since = Math.max(S.lastMsgTs, S.lastEvtTs, now() - 120);
    const es = new EventSource(`${API}/api/stream?observe=1&since=${since}`);
    S.es = es;
    let opened = false;
    const warnT = setTimeout(() => { if (!opened) setConn("warn", "连接中…"); }, 2500);
    es.onopen = () => { opened = true; clearTimeout(warnT); S.esFails = 0; stopPolling(); setConn("live", "实时 · SSE"); };
    es.addEventListener("msg", (ev) => {
      try { onLiveMsg(JSON.parse(ev.data)); } catch (e) { /* 坏帧丢弃 */ }
    });
    es.addEventListener("event", (ev) => {
      try { onLiveEvent(JSON.parse(ev.data)); } catch (e) { /* 坏帧丢弃 */ }
    });
    es.onerror = () => {
      clearTimeout(warnT);
      es.close();
      if (S.es !== es) return;
      S.esFails += 1;
      // 服务端每 10 分钟主动断一次属正常；先静默快速重连，连续失败才亮黄/改轮询
      const wait = Math.min(30000, 1000 * Math.pow(2, Math.max(0, S.esFails - 1)));
      if (S.esFails >= 2) setConn("warn", `重连中 · 第 ${S.esFails} 次`);
      if (S.esFails >= 4) startPolling();
      S.esTimer = setTimeout(startStream, navigator.onLine === false ? 5000 : wait);
    };
  }
  function startPolling() {
    if (S.pollTimer) return;
    setConn("warn", "轮询模式 · 8 秒");
    const tick = async () => {
      try {
        const since = S.lastMsgTs || now() - 600;
        const m = await api(`/api/messages?since=${since}&limit=200`);
        (m.data || []).forEach(onLiveMsg);
        const e = await api(`/api/events?since=${S.lastEvtTs || now() - 600}&limit=50`);
        (e.data || []).slice().reverse().forEach(onLiveEvent);
        if (S.mode !== "live") setConn("warn", "轮询模式 · 8 秒");
      } catch (err) { setConn("down", "离线 · 重试中"); }
    };
    tick();
    S.pollTimer = setInterval(tick, 8000);
  }
  function stopPolling() { clearInterval(S.pollTimer); S.pollTimer = null; }

  let dashSoon = null;
  function refreshSoon() { clearTimeout(dashSoon); dashSoon = setTimeout(() => loadDash(false), 2500); }
  function onLiveMsg(m) {
    if (!m || !m.msg_id) return;
    if (isChat(m) && addChat(m, true)) renderChat();
    S.lastMsgTs = Math.max(S.lastMsgTs, m.created_at || 0);
    const it = msgItem(m);
    if (!addFeed(it, true)) return;
    S.lastActivity = Math.max(S.lastActivity, m.created_at || 0);
    renderFeed(); renderTicker();
    // 粒子：发件 Agent → 中台 → 收件（广播=所有在线指挥入口）。只为真实到达的消息播放。
    const from = toAgent(m.from_instance || "") || toAgent(m.from_agent) || m.from_agent;
    let targets = [];
    if (m.to === "all") targets = (S.dash ? S.dash.agents : []).filter((a) => a.kind === "chief" && a.agent_id !== from && (a.live_status === "idle" || a.live_status === "working")).map((a) => a.agent_id);
    else if (toAgent(m.to)) targets = [toAgent(m.to)];
    if (S.view) S.view.pulse(from, targets, m.kind === "ping" ? "ping" : "msg");
    refreshSoon();
  }
  function onLiveEvent(e) {
    if (!e || !e.event_id) return;
    S.lastEvtTs = Math.max(S.lastEvtTs, e.created_at || 0);
    const it = evtItem(e);
    if (!addFeed(it, true)) return;
    S.lastActivity = Math.max(S.lastActivity, e.created_at || 0);
    renderFeed(); renderTicker();
    const src = toAgent(e.source);
    if (S.view) S.view.pulse(src || HUB, [], it.k === "alert" ? "alert" : "event");
  }

  /* ---------- KPI ---------- */
  function tween(el, to) {
    const from = Number(el.dataset.v);
    el.dataset.v = to;
    if (!isFinite(from) || from === to || reduced.matches || Math.abs(to - from) > 5000) { el.textContent = big(to); return; }
    const t0 = performance.now(), d = 700;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / d), v = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      el.textContent = big(v);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function renderKpis() {
    const d = S.dash; if (!d) return;
    const k = d.kpi, an = k.anomalies, rc = d.last_rollcall, sv = S.server;
    const act = d.agents.filter((a) => a.status === "active");
    const seg = act.map((a) => `<span class="${a.live_status === "idle" || a.live_status === "working" ? "on-" + a.kind : ""}" title="${esc(a._label)} · ${LIVE[liveOf(a)]}"></span>`).join("");
    const hours = d.messages.hourly_24h || [];
    const mx = Math.max(1, ...hours);
    const spark = hours.map((h, i) => `<span class="${i === hours.length - 1 ? "now" : ""}" style="height:${Math.max(4, (h / mx) * 100)}%" title="${h} 条"></span>`).join("");
    let rcHtml = '<div class="k-val">—</div><div class="k-sub">还没有点名记录</div>';
    if (rc) {
      const chips = (rc.replies || []).slice().sort((a, b) => a.latency_seconds - b.latency_seconds).slice(0, 6)
        .map((r) => `<span>${esc((r.from_instance || agentName(r.from_agent)).split("@")[0])} ${lat(r.latency_seconds)}</span>`).join("")
        + (rc.missing || []).slice(0, 3).map((m) => `<span class="miss">${esc((m.instance || agentName(m.agent_id)).split("@")[0])} 未回</span>`).join("");
      rcHtml = `<div class="k-val"><span data-k="rc">${rc.replied_nodes}</span><small>/ ${rc.expected_count} 节点</small></div>
        <div class="k-sub">${dtm(rc.created_at)} · 中位 <b>${lat(rc.latency_median)}</b> · 最慢 <b>${lat(rc.latency_max)}</b></div><div class="chips">${chips}</div>`;
    }
    let srv = '<div class="k-val">—</div><div class="k-sub">读取中</div>';
    if (sv) {
      const memPct = sv.mem_total_mb ? Math.round((1 - sv.mem_available_mb / sv.mem_total_mb) * 100) : null;
      const diskPct = sv.disk_total_gb ? Math.round((sv.disk_used_gb / sv.disk_total_gb) * 100) : null;
      const cert = (sv.certs || [])[0];
      srv = `<div class="k-val">${sv.loadavg ? sv.loadavg[0].toFixed(2) : "—"}<small> 负载</small></div>
        <div class="k-sub">内存 <b>${memPct ?? "—"}%</b> · 磁盘 <b>${diskPct ?? "—"}%</b><br>开机 <b>${dur(sv.uptime_seconds)}</b>${cert ? ` · 证书剩 <b>${Math.floor(cert.days_left)}</b> 天` : ""}</div>`;
    }
    const stale = act.filter((a) => a.anomalies.stale > 0).map((a) => a._label).join("、");
    const html = `
      <button class="kpi" style="--accent:var(--ok)" data-go="agents" type="button">
        <div class="k-label">在线 Agent <span class="tag">心跳已证实</span></div>
        <div class="k-val"><span data-k="on">${k.agents_online}</span><small>/ ${k.agents_total}</small></div>
        <div class="k-sub">指挥入口 <b>${k.chiefs_online}/${k.chiefs_total}</b> · 执行中 <b>${k.agents_working}</b>（按任务租约）</div>
        <div class="segbar">${seg}</div></button>
      <button class="kpi" style="--accent:var(--cyan)" data-go="feed" type="button">
        <div class="k-label">消息 · 近 1 小时</div>
        <div class="k-val"><span data-k="m1">${k.msgs_1h}</span><small>条</small></div>
        <div class="k-sub">近 24 小时 <b>${k.msgs_24h}</b> · 累计 <b>${k.msgs_total}</b></div>
        <div class="spark" aria-label="近 24 小时每小时消息数">${spark}</div></button>
      <button class="kpi" style="--accent:var(--gold)" data-go="rollcall" type="button">
        <div class="k-label">最近一次点名</div>${rcHtml}</button>
      <button class="kpi" style="--accent:var(--red)" data-go="agents-issue" type="button">
        <div class="k-label">异常计数</div>
        <div class="k-val"><span data-k="an">${big(an.total)}</span></div>
        <div class="bars3"><div class="r">死信<b>${big(an.dead)}</b></div><div class="r">未认领<b>${an.unclaimed}</b></div><div class="a">心跳过期<b>${an.stale}</b></div></div>
        <div class="k-sub" title="${esc(stale)}">${stale ? "过期：" + esc(stale) : "无心跳过期节点"}</div></button>
      <button class="kpi" style="--accent:#9b8cff" data-go="approvals" type="button">
        <div class="k-label">待大古批示</div>
        <div class="k-val"><span data-k="ap">${(k.approvals_pending || 0) + (k.decision_tasks || 0)}</span><small>项</small></div>
        <div class="k-sub">审批 <b>${k.approvals_pending || 0}</b> · 待拍板任务 <b>${k.decision_tasks || 0}</b><br>中台事件 近1h <b>${k.events_1h}</b> · 24h <b>${k.events_24h}</b> · 队列待办 <b>${k.queue.pending || 0}</b></div></button>
      <button class="kpi" style="--accent:var(--worker)" data-go="server" type="button">
        <div class="k-label">服务器 · 香港</div>${srv}</button>`;
    const box = $("#kpis");
    const prev = {};
    $$("[data-k]", box).forEach((el) => { prev[el.dataset.k] = el.dataset.v ?? el.textContent; });
    box.innerHTML = html;
    $$("[data-k]", box).forEach((el) => {
      const to = Number(el.textContent.replace(/[^\d.]/g, "")) || 0;
      const raw = el.dataset.k === "an" ? an.total : to;
      el.dataset.v = prev[el.dataset.k] !== undefined ? prev[el.dataset.k] : raw;
      tween(el, raw);
    });
  }

  /* ---------- 点名历史 ---------- */
  function renderRollcalls() {
    const list = (S.dash && S.dash.rollcalls) || [];
    if (!list.length) { $("#rollcalls").innerHTML = '<div class="empty"><b>还没有点名</b>幕僚长发出 kind=ping 的广播后，这里会出现每个节点的回复耗时</div>'; return; }
    $("#rollcalls").innerHTML = list.map((r) => {
      const pct = r.expected_count ? Math.min(100, (r.replied_nodes / r.expected_count) * 100) : 0;
      const mx = Math.max(1, ...(r.replies || []).map((x) => x.latency_seconds || 0));
      const rows = (r.replies || []).slice().sort((a, b) => a.latency_seconds - b.latency_seconds).map((x) =>
        `<div class="lat-row"><span>${esc((x.from_instance || agentName(x.from_agent)))}</span><span class="bar"><i style="width:${Math.max(4, (x.latency_seconds / mx) * 100)}%"></i></span><span class="v">${lat(x.latency_seconds)}</span></div>`).join("")
        + (r.missing || []).map((m) => `<div class="lat-row miss"><span>${esc(m.instance || agentName(m.agent_id))}</span><span class="bar"><i></i></span><span class="v">${m.online ? "在线未回" : "离线"}</span></div>`).join("");
      return `<div class="rc"><div class="rc-head"><b>${esc(r.text)}</b><time>${dtm(r.created_at)}</time></div>
        <div class="rc-meter"><i style="width:${pct}%"></i><em style="width:${100 - pct}%"></em></div>
        <div class="rc-stats"><span>回复 <b>${r.replied_nodes}/${r.expected_count}</b></span><span>中位 <b>${lat(r.latency_median)}</b></span><span>最慢 <b>${lat(r.latency_max)}</b></span>${r.missing_online_count ? `<span style="color:#ff9aa4">在线未回 <b>${r.missing_online_count}</b></span>` : ""}${r.duplicate_replies ? `<span style="color:#ffd38a" title="同一节点对同一点名重复回复（疑似重放旧消息）">重复回复 <b>${r.duplicate_replies}</b></span>` : ""}</div>
        <div class="lat">${rows}</div></div>`;
    }).join("");
  }

  /* ---------- Agent 矩阵 ---------- */
  const dotColor = (a) => (liveOf(a) === "idle" || liveOf(a) === "working" ? (a.kind === "chief" ? "var(--chief)" : "var(--worker)") : "var(--gray)");
  function anChips(an) {
    return `<span class="${an.dead ? "hot" : ""}">死信 ${big(an.dead)}</span><span class="${an.unclaimed ? "hot" : ""}">未认领 ${an.unclaimed}</span><span class="${an.stale ? "warm" : ""}">心跳过期 ${an.stale}</span>`;
  }
  function renderAgents() {
    const d = S.dash; if (!d) return;
    const f = S.agentFilter;
    const list = d.agents.filter((a) => f === "all" || (f === "issue" ? a.anomalies.total > 0 : a.kind === f));
    $("#agents").innerHTML = list.length ? list.map((a) => {
      const so = stateOf(a), pa = a.pending_approvals || 0, ps = a.pending_assists || 0;
      return `<button class="ag" data-agent="${esc(a.agent_id)}" type="button">
        ${pa + ps ? `<span class="rdot" data-ap-agent="${esc(a.agent_id)}" title="待审批 ${pa} · 等协助 ${ps}，点开处理">${pa + ps}</span>` : ""}
        <div class="ag-top"><span class="ag-dot" style="background:${dotColor(a)};box-shadow:0 0 8px ${dotColor(a)}"></span><span class="ag-name">${esc(a._label)}</span><span class="st ${so.cls}">${esc(so.text)}</span></div>
        ${so.k === "busy" ? `<div class="work" title="${so.src === "self_report" ? "Agent 自报" : "任务租约"}">▶ ${esc(so.work || "执行中")}</div>` : ""}
        <div class="ag-id">${esc(a.agent_id)}${(a.instances || []).length ? " · " + a.instances.length + " 个实例" : ""}</div>
        ${pa || ps || a.anomalies.total ? `<div class="flags">${pa ? `<span class="flag-an">待审批 ${pa}</span>` : ""}${ps ? `<span class="flag-assist">等协助 ${ps}</span>` : ""}${a.anomalies.total ? `<span class="flag-an">异常 ${big(a.anomalies.total)}</span>` : ""}</div>` : ""}
        <div class="an">${anChips(a.anomalies)}</div>
        <div class="ag-seen">最近在场 ${ago(a.presence_at)}</div></button>`;
    }).join("") : '<div class="empty"><b>没有符合条件的 Agent</b>换个筛选试试</div>';
  }

  /* ---------- 服务器 ---------- */
  function gauge(pct, label, sub, color) {
    const r = 30, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct ?? 0));
    return `<div class="gauge"><svg viewBox="0 0 80 80" role="img" aria-label="${esc(label)} ${pct ?? "—"}%">
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="7"/>
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 40 40)" style="filter:drop-shadow(0 0 4px ${color})"/>
      <text x="40" y="45" text-anchor="middle" class="gv">${pct == null ? "—" : Math.round(pct) + "%"}</text></svg>${esc(label)}<br><span>${esc(sub)}</span></div>`;
  }
  function renderServer() {
    const sv = S.server; if (!sv) return;
    const memPct = sv.mem_total_mb ? (1 - sv.mem_available_mb / sv.mem_total_mb) * 100 : null;
    const diskPct = sv.disk_total_gb ? (sv.disk_used_gb / sv.disk_total_gb) * 100 : null;
    const loadPct = sv.loadavg && sv.cpu_count ? (sv.loadavg[0] / sv.cpu_count) * 100 : null;
    const col = (p) => (p == null ? "var(--gray)" : p > 85 ? "var(--red)" : p > 65 ? "var(--amber)" : "var(--worker)");
    const certs = (sv.certs || []).map((c) => {
      const cl = c.days_left < 7 ? "var(--red)" : c.days_left < 20 ? "var(--amber)" : "var(--ok)";
      return `<div class="cert"><span>${esc(c.host)}<br><small style="color:var(--ink3)">${esc(c.issuer || "TLS 证书")} · 到期 ${fmtD.format(new Date(c.not_after * 1000))}</small></span><b style="color:${cl}">${Math.floor(c.days_left)} 天</b></div>`;
    }).join("") || '<div class="note">未读到证书文件（http 直连仍可用）</div>';
    $("#server").innerHTML = `<div class="gauges">${gauge(loadPct, "CPU 负载", sv.loadavg ? sv.loadavg.join(" / ") : "—", col(loadPct))}${gauge(memPct, "内存", sv.mem_total_mb ? `${Math.round((sv.mem_total_mb - sv.mem_available_mb) / 102.4) / 10} / ${Math.round(sv.mem_total_mb / 102.4) / 10} GB` : "—", col(memPct))}${gauge(diskPct, "磁盘", sv.disk_total_gb ? `${sv.disk_used_gb} / ${sv.disk_total_gb} GB` : "—", col(diskPct))}</div>
      <dl class="kv"><dt>系统已开机</dt><dd>${dur(sv.uptime_seconds)}</dd><dt>中台服务已运行</dt><dd>${dur(sv.service_uptime_seconds)}</dd><dt>CPU 核数</dt><dd>${sv.cpu_count ?? "—"}</dd><dt>状态库体积</dt><dd>${sv.db_mb != null ? sv.db_mb + " MB" : "—"}</dd><dt>采样时间</dt><dd>${tm(sv.now)} 北京时间</dd></dl>
      ${certs}`;
    const bad = (memPct > 90) || (diskPct > 90) || (sv.certs || []).some((c) => c.days_left < 7);
    const warn = (memPct > 75) || (diskPct > 75) || (loadPct > 80) || (sv.certs || []).some((c) => c.days_left < 20);
    const hp = $("#health-pill");
    hp.dataset.s = bad ? "bad" : warn ? "warn" : "live";
    hp.querySelector("b").textContent = bad ? "服务器告警" : warn ? "服务器需关注" : "服务器正常";
  }

  function renderTicker() {
    const d = S.dash; if (!d) return;
    const top = (d.messages.links_24h || []).slice(0, 3).map((l) => `<div class="tk-row"><span>${esc(agentName(l.from))} → ${esc(agentName(toAgent(l.to) || l.to))}</span><b>${l.count_24h}</b></div>`).join("");
    $("#ticker").innerHTML = `<div class="tk-row"><span>最近一条消息</span><b>${S.lastActivity ? ago(S.lastActivity) : "—"}</b></div>
      <div class="tk-row"><span>实时通道</span><b>${S.mode === "live" ? "SSE 已连" : S.mode === "warn" ? "重连/轮询" : S.mode === "down" ? "断开" : "连接中"}</b></div>
      <div class="tk-row" style="border-top:1px solid var(--line);padding-top:6px"><span>24 小时最忙的连线</span><span></span></div>${top || '<div class="tk-row"><span>暂无</span></div>'}`;
  }

  /* ---------- 拓扑图数据 ---------- */
  function buildGraph() {
    const d = S.dash; if (!d) return;
    const vol = {};
    (d.messages.links_24h || []).forEach((l) => {
      vol[l.from] = (vol[l.from] || 0) + l.count_24h;
      const t = toAgent(l.to); if (t) vol[t] = (vol[t] || 0) + l.count_24h;
    });
    const rel = {};
    (S.relations || []).forEach((r) => { rel[r.target] = (rel[r.target] || 0) + (r.task_count || 0); });
    const nodes = [{ id: HUB, label: "中台", kind: "hub", live: "idle", weight: 1, anomalies: { total: 0 } }];
    d.agents.filter((a) => a.status === "active" || a.status === "disabled").forEach((a) => {
      nodes.push({ id: a.agent_id, label: a._label, kind: a.kind, live: a.status === "active" ? a.live_status : "disabled", working: a.live_status === "working" || stateOf(a).k === "busy",
        weight: (vol[a.agent_id] || 0) + (rel[a.agent_id] || 0), msgs: vol[a.agent_id] || 0, tasks: rel[a.agent_id] || 0,
        anomalies: a.anomalies, presence_at: a.presence_at, instances: a.instances,
        sub: stateLine(a).slice(0, 22), pending: (a.pending_approvals || 0) + (a.pending_assists || 0) });
    });
    S.graph = { nodes, hub: HUB };
    ensureView();
    if (S.view) S.view.setData(S.graph);
    renderLegend();
  }

  function renderLegend() {
    const lg = $("#legend");
    const collapsed = mobile.matches ? (lg.dataset.collapsed ?? "true") : "false";
    lg.dataset.collapsed = collapsed;
    lg.innerHTML = `<summary role="button" tabindex="0">图例 ${collapsed === "true" ? "▸" : "▾"}</summary>
      <div class="lg"><span class="dot" style="background:var(--gold);box-shadow:0 0 8px var(--gold)"></span>中台 / 选中</div>
      <div class="lg"><span class="dot" style="background:var(--chief)"></span>指挥入口（chief）</div>
      <div class="lg"><span class="dot" style="background:var(--worker)"></span>执行者（worker）</div>
      <div class="lg"><span class="dot" style="background:var(--gray)"></span>离线 / 未接入（暗、无光晕）</div>
      <div class="lg"><span class="ln" style="background:var(--gold)"></span>粗金线：24h 消息往来</div>
      <div class="lg"><span class="ln" style="background:var(--cyan);height:1px"></span>细青线：任务委派 / 无消息</div>
      <div class="lg"><span class="dot" style="background:#fff;box-shadow:0 0 8px var(--cyan)"></span>光点：真实消息/事件到达</div>
      <div class="lg"><span class="dot" style="background:var(--red)"></span>右上红角标：异常数</div>
      <div class="lg"><span class="dot" style="background:var(--red);box-shadow:0 0 0 2px #fff inset"></span>左上红点+数字：待审批/等协助</div>
      <div class="lg"><span class="dot" style="background:transparent;border:1px dashed var(--gold)"></span>金色虚环：忙碌（自报/租约）</div>
      <div class="lt">中台是恒星，Agent 是行星。节点大小 = 24h 消息 + 任务量；亮度 = 在线（5 分钟内心跳）；标签 = 名称 · 状态 · 在做什么。没有消息时画面静止，不做假动态。</div>`;
  }

  /* ---------- 视图：3D（桌面）/ 平面（手机、低端、减少动效） ---------- */
  function webglOK() {
    try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch (e) { return false; }
  }
  function want3D() {
    const pref = localStorage.getItem("sb.view");
    if (pref === "lite") return false;
    if (pref === "3d") return webglOK();
    const saveData = navigator.connection && navigator.connection.saveData;
    const lowMem = navigator.deviceMemory && navigator.deviceMemory < 4;
    const lowCpu = navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4;
    return !mobile.matches && !saveData && !lowMem && !lowCpu && webglOK();
  }
  let loading3D = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function ensureView() {
    const kind = want3D() ? "3d" : "lite";
    if (S.view && S.viewKind === kind) return;
    if (kind === "3d") {
      if (S.viewKind === "3d-loading") return;
      S.viewKind = "3d-loading";
      loading3D = loading3D || (window.THREE ? Promise.resolve() : loadScript("../vendor/three.min.js?v=r150")).then(() => (window.SB3D ? null : loadScript("v2/scene3d.js?v=2.0.0")));
      loading3D.then(() => { mountView("3d"); }).catch(() => { localStorage.setItem("sb.view", "lite"); mountView("lite"); toast("3D 场景加载失败，已切到平面模式"); });
      return;
    }
    mountView("lite");
  }
  function mountView(kind) {
    if (S.view) { S.view.dispose(); S.view = null; }
    const box = $("#stage");
    box.innerHTML = "";
    const opts = { reduced: reduced.matches, onSelect: (id) => openNode(id), onHover: () => {} };
    try {
      S.view = kind === "3d" ? window.SB3D.create(box, opts) : Lite.create(box, opts);
      S.viewKind = kind;
    } catch (e) {
      S.view = Lite.create(box, opts); S.viewKind = "lite"; kind = "lite";
    }
    $(".stage").dataset.mode = kind;
    $("#stage-mode").textContent = kind === "3d" ? "3D · WebGL" : "平面 · 轻量";
    $("#btn-mode").textContent = kind === "3d" ? "切到平面" : "切到 3D";
    $("#stage-hint").textContent = kind === "3d" ? "拖拽旋转 · 滚轮/双指缩放 · 点节点看详情" : "点节点看详情";
    if (S.graph) S.view.setData(S.graph);
  }

  /* 平面轻量版：Canvas 2D 放射图（中台居中，指挥入口内环，执行者外环），同一套颜色语义 */
  const Lite = {
    create(box, opts) {
      const cv = document.createElement("canvas");
      cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "协作网平面拓扑");
      box.appendChild(cv);
      const ctx = cv.getContext("2d");
      let W = 0, H = 0, dpr = 1, nodes = [], pos = {}, sel = null, parts = [], raf = 0, flash = {};
      const COL = { hub: "#f5c451", chief: "#ff5fa2", worker: "#3ee6c1", off: "#6b7a90" };
      function layout() {
        const r = box.getBoundingClientRect();
        dpr = Math.min(2, window.devicePixelRatio || 1); W = r.width; H = r.height;
        cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
        const cx = W / 2, cy = H * 0.46, R1 = Math.min(W, H) * 0.24, R2 = Math.min(W, H) * 0.4;
        pos = {}; pos[HUB] = { x: cx, y: cy };
        const chiefs = nodes.filter((n) => n.kind === "chief"), workers = nodes.filter((n) => n.kind === "worker");
        chiefs.forEach((n, i) => { const a = -Math.PI / 2 + (i / chiefs.length) * Math.PI * 2; pos[n.id] = { x: cx + R1 * Math.cos(a), y: cy + R1 * 0.82 * Math.sin(a) }; });
        workers.forEach((n, i) => { const a = -Math.PI / 2 + ((i + 0.5) / workers.length) * Math.PI * 2; pos[n.id] = { x: cx + R2 * Math.cos(a), y: cy + R2 * 0.8 * Math.sin(a) }; });
        draw();
      }
      const isOn = (n) => n.kind === "hub" || n.live === "idle" || n.live === "working";
      const rad = (n) => (n.kind === "hub" ? 18 : (n.kind === "chief" ? 8 : 6) + Math.min(6, Math.log2(1 + (n.weight || 0))));
      function draw(t) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const hub = pos[HUB]; if (!hub) return;
        nodes.forEach((n) => {
          if (n.id === HUB) return; const p = pos[n.id]; if (!p) return;
          const strong = (n.msgs || 0) > 0;
          ctx.strokeStyle = strong ? "rgba(245,196,81,.45)" : "rgba(76,201,255,.22)";
          ctx.lineWidth = strong ? Math.min(4, 1 + Math.log2(1 + n.msgs) / 2) : 1;
          ctx.globalAlpha = isOn(n) ? 1 : 0.35;
          ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        });
        ctx.globalAlpha = 1;
        nodes.forEach((n) => {
          const p = pos[n.id]; if (!p) return;
          const c = n.kind === "hub" ? COL.hub : isOn(n) ? COL[n.kind] : COL.off;
          const r = rad(n);
          if (isOn(n)) { const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3); g.addColorStop(0, c + "66"); g.addColorStop(1, c + "00"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, 7); ctx.fill(); }
          const fl = flash[n.id]; if (fl && t && t - fl < 900) { ctx.strokeStyle = "rgba(255,255,255," + (1 - (t - fl) / 900) + ")"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4 + (t - fl) / 60, 0, 7); ctx.stroke(); }
          ctx.fillStyle = c; ctx.globalAlpha = isOn(n) ? 1 : 0.45; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
          if (sel === n.id) { ctx.strokeStyle = COL.hub; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, 7); ctx.stroke(); }
          if (n.working) { ctx.strokeStyle = COL.hub; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, r + 8, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
          ctx.fillStyle = isOn(n) ? "#e8eef8" : "#7d8aa0"; ctx.font = `${n.kind === "hub" ? 600 : 500} ${n.kind === "hub" ? 12 : 11}px ${getComputedStyle(document.body).fontFamily}`;
          ctx.textAlign = "center"; ctx.fillText(n.label, p.x, p.y + r + 14);
          if (n.sub && n.kind !== "hub") { ctx.font = `400 9.5px ${getComputedStyle(document.body).fontFamily}`; ctx.fillStyle = /^忙碌/.test(n.sub) ? "#ffdf8a" : "#7d8aa0"; ctx.fillText(n.sub.slice(0, 12), p.x, p.y + r + 26); }
          if (n.pending) { ctx.fillStyle = "#ff4d5e"; ctx.beginPath(); ctx.arc(p.x - r - 2, p.y - r - 3, 7, 0, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.font = "700 9px sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(n.pending), p.x - r - 2, p.y - r);  }
          const an = n.anomalies && n.anomalies.total;
          if (an) { const s = big(an); ctx.font = "600 9.5px sans-serif"; const w = ctx.measureText(s).width + 8; ctx.fillStyle = "#ff4d5e"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(p.x + r - 2, p.y - r - 10, w, 14, 7) : ctx.rect(p.x + r - 2, p.y - r - 10, w, 14); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.fillText(s, p.x + r + 2, p.y - r + 1); }
        });
        parts.forEach((pt) => {
          const k = Math.min(1, (t - pt.t0) / pt.d); const a = pos[pt.a], b = pos[pt.b]; if (!a || !b) return;
          const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 9); g.addColorStop(0, pt.c); g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
        });
      }
      function loop(t) {
        parts = parts.filter((p) => t - p.t0 < p.d + 20);
        parts.forEach((p) => { if (!p.done && t - p.t0 >= p.d) { p.done = true; flash[p.b] = t; if (p.next) p.next(t); } });
        draw(t);
        const busy = parts.length || Object.values(flash).some((f) => t - f < 900);
        raf = busy ? requestAnimationFrame(loop) : 0;
        if (!busy) draw();
      }
      function kick() { if (!raf) raf = requestAnimationFrame(loop); }
      function hit(ev) {
        const r = cv.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top;
        let best = null, bd = 1e9;
        nodes.forEach((n) => { const p = pos[n.id]; if (!p) return; const d = Math.hypot(p.x - x, p.y - y); if (d < Math.max(22, rad(n) + 10) && d < bd) { bd = d; best = n.id; } });
        return best;
      }
      cv.addEventListener("click", (ev) => { const id = hit(ev); if (id) { sel = id; draw(); opts.onSelect(id); } });
      cv.addEventListener("mousemove", (ev) => { cv.style.cursor = hit(ev) ? "pointer" : "default"; });
      const ro = new ResizeObserver(() => layout()); ro.observe(box);
      return {
        setData(g) { nodes = g.nodes; layout(); },
        pulse(from, targets, kind) {
          if (opts.reduced || reduced.matches) { const t = performance.now(); flash[from] = t; (targets || []).forEach((x) => { flash[x] = t; }); flash[HUB] = t; kick(); return; }
          const c = kind === "ping" ? "rgba(255,223,138,1)" : kind === "alert" ? "rgba(255,77,94,1)" : kind === "event" ? "rgba(200,210,255,.9)" : "rgba(130,220,255,1)";
          const t0 = performance.now();
          const leg2 = (t) => (targets || []).forEach((b) => parts.push({ a: HUB, b, t0: t, d: 650, c }));
          if (from && from !== HUB && pos[from]) parts.push({ a: from, b: HUB, t0, d: 650, c, next: leg2 }); else { flash[HUB] = t0; leg2(t0); }
          kick();
        },
        select(id) { sel = id; draw(); },
        reset() { sel = null; draw(); },
        dispose() { cancelAnimationFrame(raf); ro.disconnect(); cv.remove(); },
      };
    },
  };

  /* ---------- 抽屉 ---------- */
  let lastFocus = null;
  function openDrawer(html) {
    const dr = $("#drawer");
    lastFocus = document.activeElement;
    dr.innerHTML = html; dr.setAttribute("aria-hidden", "false");
    $("#scrim").hidden = false;
    dr.focus({ preventScroll: true });
    $(".dr-close", dr).addEventListener("click", closeDrawer);
  }
  function closeDrawer() {
    $("#drawer").setAttribute("aria-hidden", "true"); $("#scrim").hidden = true;
    if (S.view) S.view.reset();
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  const head = (title, sub, dot) => `<div class="dr-head"><h3>${dot ? `<span class="ag-dot" style="background:${dot};box-shadow:0 0 10px ${dot}"></span>` : ""}${title}</h3><p>${sub}</p><button class="dr-close" type="button" aria-label="关闭">×</button></div>`;

  function openNode(id) {
    if (S.view) S.view.select(id);
    if (id === HUB) return openHub();
    openAgent(id);
  }
  function openHub() {
    const d = S.dash, k = d.kpi;
    openDrawer(head("中台 · 消息总线", "所有 Agent 经中台收发；香港服务器 super-brain.service", "var(--gold)") + `<div class="dr-body">
      <div class="stats4"><div><b>${k.msgs_1h}</b><span>近 1 小时消息</span></div><div><b>${k.msgs_24h}</b><span>近 24 小时消息</span></div><div><b>${k.events_1h}</b><span>近 1 小时事件</span></div><div><b>${k.agents_online}/${k.agents_total}</b><span>在线 Agent</span></div></div>
      <div><h4>任务队列</h4><div class="an">${Object.entries(k.queue).map(([s, n]) => `<span class="${s === "dead" || s === "failed" ? "hot" : ""}">${TASK[s] || s} ${big(n)}</span>`).join("")}</div></div>
      <div><h4>24 小时消息连线</h4><div class="list">${(d.messages.links_24h || []).map((l) => `<div class="li"><div class="li-top"><span class="who ${whoCls(l.from)}">${esc(agentName(l.from))}</span><span class="arrow">→</span><span class="who">${esc(agentName(toAgent(l.to) || l.to))}</span><span style="margin-left:auto">${l.count_24h} 条 · 最近 ${ago(l.last_at)}</span></div></div>`).join("") || '<div class="note">24 小时内无消息</div>'}</div></div>
      <div class="note">异常口径：死信=点名该 Agent 的 dead 任务；未认领=点名该 Agent、pending 超过 ${d.rules.unclaimed_seconds / 60} 分钟无人领；心跳过期=曾接入但超过 ${d.rules.offline_seconds / 60} 分钟无在场信号。死信数每 ${d.rules.dead_cache_seconds / 60} 分钟统计一次。</div></div>`);
  }
  async function openAgent(id) {
    const a = S.agentById[id]; if (!a) return;
    const lv = liveOf(a);
    const dot = lv === "idle" || lv === "working" ? (a.kind === "chief" ? "var(--chief)" : "var(--worker)") : "var(--gray)";
    const inst = (a.instances || []).map((i) => `<div class="li"><div class="li-top"><b style="color:var(--ink)">${esc(i.name)}</b><span>${esc(i.location || "")}</span><span class="st ${i.online ? "idle" : "offline"}">${i.online ? "心跳正常" : "心跳过期"}</span></div><div class="note">最近心跳 ${i.heartbeat_at ? dtm(i.heartbeat_at) + "（" + ago(i.heartbeat_at) + "）" : "从未"} · 通道 ${esc(i.note || "—")}</div></div>`).join("");
    const opBind = () => { $$("#drawer [data-op]").forEach((b) => { b.onclick = () => onAgentOp(b, id); }); };
    const so = stateOf(a), npa = (a.pending_approvals || 0) + (a.pending_assists || 0);
    openDrawer(head(esc(a._label), `${esc(a.agent_id)} · ${a.kind === "chief" ? "指挥入口" : "执行者"} · <span class="st ${so.cls}">${esc(so.text)}</span>`, dot) + `<div class="dr-body">
      ${so.k === "busy" ? `<div class="li"><div class="li-top"><b style="color:var(--gold2)">正在做</b><span>${so.src === "self_report" ? "Agent 自报（/cmd work）" : "任务租约"}${so.since ? " · 始于 " + dtm(so.since) : ""}</span></div><div class="fi-text">${esc(so.work || "")}</div></div>` : ""}
      ${npa ? `<div><h4>待你处理 <span class="tag red">${npa}</span></h4><div class="list" id="dr-aps"></div></div>` : ""}
      <div class="stats4"><div><b>${ago(a.presence_at)}</b><span>最近在场（${esc(a.presence_via || "无")}）</span></div><div><b>${(a.instances || []).filter((i) => i.online).length}/${(a.instances || []).length}</b><span>实例心跳正常</span></div><div><b style="color:${a.anomalies.total ? "#ff9aa4" : "inherit"}">${big(a.anomalies.total)}</b><span>异常合计</span></div><div><b>${(a.doing_task_ids || []).length}</b><span>执行中任务（租约）</span></div></div>
      ${agentActions(a)}
      <div><h4>异常计数</h4><div class="an">${anChips(a.anomalies)}</div></div>
      ${inst ? `<div><h4>实例与心跳</h4><div class="list">${inst}</div></div>` : ""}
      <div><h4>最近消息</h4><div class="list" id="dr-msgs"><div class="note"><span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span> 读取中</div></div></div>
      <div><h4>任务轨迹</h4><div class="list" id="dr-tasks"><div class="note">读取中</div></div></div>
      <div class="note">“在线”只认 5 分钟内心跳 / 在场信号；“忙碌”只认 Agent 自报（/cmd work）或任务租约，心跳不算在干活。离线时长按最近在场计算，空闲时长按最近一次发消息/交任务计算。</div></div>`);
    opBind();
    if (npa) renderAgentApprovals(id);
    const [m, t] = await Promise.allSettled([api(`/api/messages?agent=${encodeURIComponent(id)}&limit=30`), api(`/api/agents/${encodeURIComponent(id)}`)]);
    const mb = $("#dr-msgs"), tb = $("#dr-tasks");
    if (mb) mb.innerHTML = m.status === "fulfilled" ? ((m.value.data || []).map((x) => `<div class="li"><div class="li-top"><time>${dtm(x.created_at)}</time><span class="who ${whoCls(x.from_agent)}">${esc(agentName(x.from_agent))}</span><span class="arrow">→</span><span class="who">${esc(agentName(toAgent(x.to) || x.to))}</span>${x.kind === "ping" ? '<span class="tag ping">点名</span>' : x.reply_to ? '<span class="tag">回复</span>' : ""}</div><div class="fi-text">${esc(x.text)}</div></div>`).join("") || '<div class="note">没有收发记录</div>') : `<div class="note">读取失败：${esc(m.reason && m.reason.message)}</div>`;
    if (tb) {
      if (t.status !== "fulfilled") { tb.innerHTML = `<div class="note">读取失败：${esc(t.reason && t.reason.message)}</div>`; return; }
      const rt = t.value.data.recent_tasks || [];
      tb.innerHTML = rt.length ? rt.map((r) => `<button class="li" style="text-align:left" data-task="${r.id}" type="button"><div class="li-top"><b style="color:var(--ink)">#${r.id}</b><span class="tag">${esc(r.type)}</span><span class="st ${r.status === "done" ? "idle" : r.status === "doing" ? "working" : r.status === "pending" ? "unused" : "offline"}">${TASK[r.status] || r.status}</span><time style="margin-left:auto">${dtm(r.done_at || r.claimed_at || r.created_at)}</time></div><div class="fi-text">${esc(r.instruction || r.summary || "")}</div><div class="task-ev" hidden></div></button>${taskActs(r)}`).join("") : '<div class="note">这个 Agent 名下没有认领过的任务（指挥入口通常只发指令、不领任务）</div>';
    }
  }
  async function toggleTask(btn) {
    const box = $(".task-ev", btn);
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false; box.textContent = "读取轨迹…";
    try {
      const d = (await api(`/api/tasks/${btn.dataset.task}`)).data;
      const evs = d.events || [];
      box.innerHTML = (evs.length ? evs.map((e) => `<div>${dtm(e.created_at)} · ${esc(e.source)} · ${esc(e.type)} · ${esc(e.status || "")}</div>`).join("") : "<div>无事件留痕</div>")
        + (d.result_paths && d.result_paths.length ? `<div>产出：${d.result_paths.map(esc).join("、")}</div>` : "");
    } catch (e) { box.textContent = "读取失败：" + e.message; }
  }
  async function openFeedItem(id) {
    const it = S.feed.find((x) => x.id === id); if (!it) return;
    if (it.k === "event" || it.k === "alert") {
      const e = it.raw;
      openDrawer(head("事件 " + esc(e.type), `${dtm(e.created_at)} 北京时间 · 来源 ${esc(e.source)}`) + `<div class="dr-body"><dl class="kv"><dt>事件号</dt><dd class="mono">${esc(e.event_id)}</dd><dt>状态</dt><dd>${esc(e.status)}</dd><dt>优先级</dt><dd>${esc(e.priority)}</dd><dt>父事件</dt><dd class="mono">${esc(e.parent_id || "—")}</dd></dl></div>`);
      return;
    }
    const m = it.raw;
    openDrawer(head(m.kind === "ping" ? "点名广播" : "消息", `${dtm(m.created_at)} 北京时间 · ${esc(agentName(m.from_agent))}${m.from_instance ? "（" + esc(m.from_instance) + "）" : ""} → ${esc(agentName(toAgent(m.to) || m.to))}`) + `<div class="dr-body">
      <div class="li"><div class="doc">${esc(m.text)}</div></div>
      <dl class="kv"><dt>消息号</dt><dd class="mono">${esc(m.msg_id)}</dd><dt>回复给</dt><dd class="mono">${esc(m.reply_to || "—")}</dd><dt>会话</dt><dd class="mono">${esc(m.thread_id || "—")}</dd></dl>
      <div><h4>同一会话（该消息前后）</h4><div class="list" id="dr-thread"><div class="note">读取中</div></div></div></div>`);
    try {
      const th = m.thread_id || m.msg_id;
      const j = await api(`/api/messages?thread=${encodeURIComponent(th)}&since=${Math.max(0, (m.created_at || 0) - 1800)}&limit=60`);
      const rows = (j.data || []).slice(-30).reverse();
      $("#dr-thread").innerHTML = rows.map((x) => `<div class="li"><div class="li-top"><time>${dtm(x.created_at)}</time><span class="who ${whoCls(x.from_agent)}">${esc(x.from_instance || agentName(x.from_agent))}</span></div><div class="fi-text">${esc(x.text)}</div></div>`).join("") || '<div class="note">没有同会话消息</div>';
    } catch (e) { $("#dr-thread").innerHTML = `<div class="note">读取失败：${esc(e.message)}</div>`; }
  }

  /* ---------- 知识库 ---------- */
  function hl(text, q) {
    const s = esc(text); if (!q) return s;
    const i = s.toLowerCase().indexOf(esc(q).toLowerCase());
    return i < 0 ? s : s.slice(0, i) + "<mark>" + s.slice(i, i + esc(q).length) + "</mark>" + s.slice(i + esc(q).length);
  }
  async function searchKb(q) {
    S.kbQ = q;
    $("#kb").innerHTML = '<div class="kb-item skeleton" style="height:84px"></div><div class="kb-item skeleton" style="height:84px"></div><div class="kb-item skeleton" style="height:84px"></div>';
    try {
      const j = await api(`/api/knowledge?limit=${q ? 30 : 12}${q ? "&q=" + encodeURIComponent(q) : ""}`);
      const items = q ? j.data : (j.data || []).slice().reverse();
      $("#kb-note").textContent = q ? `“${q}” 命中 ${j.total} 篇` : `共 ${j.total} 篇 · 显示最近 ${items.length} 篇`;
      $("#kb").innerHTML = items.length ? items.map((k) => `<button class="kb-item" data-path="${esc(k.path)}" type="button"><b>${hl(k.title, q)}</b><small>${esc(k.category)}${k.updated || k.created ? " · " + esc(k.updated || k.created) : ""}${(k.tags || []).length ? " · " + k.tags.slice(0, 3).map(esc).join(" / ") : ""}</small><p>${hl(k.snippet || "", q)}</p></button>`).join("")
        : `<div class="empty"><b>没找到“${esc(q)}”</b>换个关键词，或去掉筛选再试</div>`;
    } catch (e) {
      $("#kb").innerHTML = `<div class="empty" role="alert"><b>检索失败</b>${esc(e.message)} <button class="chip" type="button" id="kb-retry">重试</button></div>`;
      $("#kb-retry").onclick = () => searchKb(q);
    }
  }
  async function openDoc(path) {
    openDrawer(head("知识库", esc(path)) + '<div class="dr-body"><div class="note">读取中…</div></div>');
    try {
      const d = (await api(`/api/knowledge/file?path=${encodeURIComponent(path)}`)).data;
      $("#drawer .dr-head h3").textContent = d.title;
      $("#drawer .dr-head p").textContent = `${d.category} · ${d.path} · ${(d.bytes / 1024).toFixed(1)} KB${d.truncated ? " · 已截断" : ""}`;
      $("#drawer .dr-body").innerHTML = `<div class="acts"><button class="act gold" id="kb-edit-btn" type="button" ${d.truncated ? "disabled" : ""}>编辑</button>${own() ? "" : '<span class="lock">编辑需先配对本设备</span>'}</div><div class="doc">${esc(d.content)}</div>`;
      $("#kb-edit-btn").onclick = () => editDoc(d);
    } catch (e) { $("#drawer .dr-body").innerHTML = `<div class="note" role="alert">读取失败：${esc(e.message)}</div>`; }
  }

  /* ---------- 大古操作：设备配对、写操作、审批中心、审计 ----------
     查看免口令；写操作只认 dagu-owner 设备令牌（一次性配对码换取，存本机 localStorage）。
     不提供删除、交易类按钮。每次写操作服务端都会记审计。 */
  const OWN_KEY = "sb.owner.v1";
  const own = () => { try { return JSON.parse(localStorage.getItem(OWN_KEY) || "null"); } catch (e) { return null; } };
  function setOwn(v) { if (v) localStorage.setItem(OWN_KEY, JSON.stringify(v)); else localStorage.removeItem(OWN_KEY); renderOwnerPill(); }
  function renderOwnerPill() {
    const o = own(), el = $("#owner-pill");
    el.dataset.s = o ? "owner" : "idle";
    el.querySelector("b").textContent = o ? `大古 · ${o.device || "本设备"}` : "未配对 · 只读";
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "设备";
    const app = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "主屏App" : "浏览器";
    return `${os} ${app} ${new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "2-digit", day: "2-digit" }).format(new Date())}`;
  }
  async function postJSON(path, body, token) {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = "Bearer " + token;
    const r = await fetch(API + path, { method: "POST", headers: h, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) { j = { ok: false, error: "HTTP " + r.status }; }
    j._status = r.status;
    return j;
  }
  async function pairWith(code) {
    const j = await postJSON("/api/owner/pair", { code, device_name: deviceName() });
    if (j.ok && j.token) { setOwn({ token: j.token, device: j.device, device_id: j.device_id, at: Math.floor(Date.now() / 1000) }); return { ok: true }; }
    return { ok: false, error: j.error || "配对失败" };
  }
  async function checkPairHash() {
    const m = location.hash.match(/[#&]pair=([^&]+)/);
    if (!m) return;
    const code = decodeURIComponent(m[1]);
    history.replaceState(null, "", location.pathname + location.search);   // 配对码不留在地址栏/历史里
    const r = await pairWith(code);
    toast(r.ok ? "本设备已配对，之后可直接操作" : "配对失败：" + r.error);
  }
  async function askPair() {
    const v = await dlg({ title: "配对本设备", desc: "写操作需要大古身份。粘贴配对码（或配对链接）即可；配对后本设备长期有效，可在「设备」里退出。", placeholder: "配对码 / 配对链接 / 主口令", rows: 2, okText: "配对" });
    if (!v || !v.value) return false;
    let code = v.value.trim();
    const m = code.match(/[#&]pair=([^&\s]+)/); if (m) code = decodeURIComponent(m[1]);
    let r = await pairWith(code);
    if (!r.ok) {   // 也接受 owner 主口令：自检通过才保存
      try {
        const w = await fetch(API + "/api/owner/whoami", { headers: { Authorization: "Bearer " + code } });
        if (w.ok) { setOwn({ token: code, device: "主口令", device_id: null }); r = { ok: true }; }
      } catch (e) { /* 忽略 */ }
    }
    toast(r.ok ? "配对成功" : "配对失败：" + r.error);
    return r.ok;
  }
  async function act(action, args, okMsg) {
    let o = own();
    if (!o) { if (!(await askPair())) return null; o = own(); }
    const j = await postJSON("/api/owner/act", { action, args: args || {} }, o.token);
    if (j._status === 401) { setOwn(null); toast("本设备授权已失效，请重新配对"); if (await askPair()) return act(action, args, okMsg); return null; }
    if (!j.ok) { toast("没成功：" + (j.error || "未知原因")); loadAudit(); return j; }
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(j) : okMsg);
    loadAudit(); refreshSoon(); loadApprovals();
    if (/^(project|phase)_/.test(action)) loadProjects();
    return j;
  }
  /* 通用对话框：文本 / 下拉选择 / 确认 */
  function dlg({ title, desc = "", placeholder = "", value = "", rows = 4, okText = "确定", select = null, input = true, required = false, danger = false }) {
    const d = $("#dlg");
    $("#dlg-title").textContent = title; $("#dlg-desc").textContent = desc;
    const ta = $("#dlg-input"); ta.hidden = !input; ta.value = value; ta.placeholder = placeholder; ta.rows = rows;
    $("#dlg-extra").innerHTML = select ? `<label class="sr" for="dlg-sel">选择</label><select id="dlg-sel">${select.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>` : "";
    const ok = $("#dlg-ok"); ok.textContent = okText; ok.className = danger ? "btn act no" : "btn";
    return new Promise((res) => {
      const done = (v) => { d.close(); $("#dlg-form").onsubmit = null; $("#dlg-cancel").onclick = null; d.oncancel = null; res(v); };
      $("#dlg-form").onsubmit = (e) => {
        e.preventDefault();
        const val = ta.value.trim();
        if (input && required && !val) { ta.focus(); toast("请填写内容"); return; }
        done({ value: val, target: select ? $("#dlg-sel").value : null });
      };
      $("#dlg-cancel").onclick = () => done(null);
      d.oncancel = () => done(null);
      if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
      setTimeout(() => (input ? ta : ok).focus(), 30);
    });
  }
  const targets = () => (S.dash ? S.dash.agents : []).filter((a) => a.status === "active").flatMap((a) =>
    [{ value: a.agent_id, label: `${a._label}（${a.agent_id}）` }].concat((a.instances || []).map((i) => ({ value: i.name, label: `└ ${i.name}` }))));

  async function settings() {
    const o = own();
    let devs = "";
    if (o) {
      const j = await postJSON("/api/owner/act", { action: "devices", args: {} }, o.token);
      if (j._status === 401) { setOwn(null); return settings(); }
      devs = (j.devices || []).map((d) => `<div class="li"><div class="li-top"><b style="color:var(--ink)">${esc(d.name)}</b>${d.id === j.current ? '<span class="tag ping">本机</span>' : ""}${d.revoked_at ? '<span class="tag">已吊销</span>' : ""}<span style="margin-left:auto">配对 ${dtm(d.created_at)} · 最近 ${d.last_used_at ? ago(d.last_used_at) : "—"}</span></div>${!d.revoked_at && d.id !== j.current ? `<div class="acts"><button class="act no" data-revoke="${d.id}" type="button">吊销这台</button></div>` : ""}</div>`).join("") || '<div class="note">没有配对设备</div>';
    }
    openDrawer(head("设备与权限", o ? `本机已配对为大古（${esc(o.device || "")}）` : "本机未配对：只能查看，不能操作", o ? "var(--gold)" : "var(--gray)") + `<div class="dr-body">
      ${o ? `<div class="acts"><button class="act gold" id="st-newlink" type="button">生成新设备配对链接</button><button class="act no" id="st-logout" type="button">退出本设备</button></div>
        <div id="st-link"></div><div><h4>已配对设备</h4><div class="list">${devs}</div></div>`
      : `<div class="acts"><button class="act gold" id="st-pair" type="button">输入配对码</button></div>`}
      <div><h4>提醒</h4>${prefRows()}</div>
      ${o ? `<div><h4>口令包 <small style="color:var(--ink3);font-weight:400">只显示名称和用途，值永不回显</small></h4><div id="st-vault" class="list"><div class="note">读取中…</div></div><div class="acts"><button class="act gold" id="st-vault-add" type="button">存入 / 更新口令</button></div></div>` : ""}
      <div class="note">口令和配对码只在本机保存，不会显示在页面或日志里。配对链接一次性、24 小时内有效。查看始终免口令；所有写操作都会记入「操作审计」。不提供删除和交易类操作。</div></div>`);
    const dr = $("#drawer");
    if ($("#st-pair", dr)) $("#st-pair", dr).onclick = async () => { if (await askPair()) settings(); };
    if ($("#st-logout", dr)) $("#st-logout", dr).onclick = async () => {
      const c = await dlg({ title: "退出本设备？", desc: "退出后本机令牌立即作废，再操作需要重新配对。", input: false, okText: "退出", danger: true });
      if (!c) return;
      await postJSON("/api/owner/act", { action: "logout", args: {} }, own().token);
      setOwn(null); loadAudit(); closeDrawer(); toast("已退出，本机恢复只读");
    };
    if ($("#st-newlink", dr)) $("#st-newlink", dr).onclick = async () => {
      const j = await act("pair_code_create", {});
      if (!j || !j.ok) return;
      const link = `${location.origin}${location.pathname}#pair=${encodeURIComponent(j.code)}`;
      $("#st-link", dr).innerHTML = `<div class="linkbox" id="st-linkbox">${esc(link)}</div><div class="acts"><button class="act gold" id="st-copy" type="button">复制链接</button><span class="note">一次性 · ${dtm(j.expires_at)} 前有效 · 只显示这一次</span></div>`;
      $("#st-copy", dr).onclick = async () => { try { await navigator.clipboard.writeText(link); toast("已复制，发到新设备上打开即可"); } catch (e) { toast("复制失败，请长按选择链接"); } };
    };
    bindPrefs(dr);
    if (o) loadVault(dr);
    dr.querySelectorAll("[data-revoke]").forEach((b) => { b.onclick = async () => {
      const c = await dlg({ title: "吊销这台设备？", input: false, okText: "吊销", danger: true }); if (!c) return;
      const j = await act("device_revoke", { device_id: Number(b.dataset.revoke) }, "已吊销"); if (j && j.ok) settings(); }; });
  }

  /* 审批中心 */
  async function loadApprovals() {
    try { S.appr = (await api("/api/approvals")).data; renderApprovals(); } catch (e) { $("#approvals").innerHTML = `<div class="empty" role="alert"><b>读取失败</b>${esc(e.message)}</div>`; }
  }
  function renderApprovals() {
    const d = S.appr; if (!d) return;
    const pend = (d.approvals || []).filter((a) => a.status === "pending");
    const n = pend.length + (d.decision_tasks || []).length;
    $("#ap-count").textContent = n ? `待处理 ${n}` : "暂无待处理";
    const bd = $("#tab-ap-badge"); bd.hidden = !n; bd.textContent = n;
    const ap = (d.approvals || []).map(apvCard).join("");
    const tk = (d.decision_tasks || []).map((t) => `<div class="apv task">
      <div class="apv-top"><b>任务 #${t.id}</b><span class="tag">${esc(t.type)}</span><span>${esc(agentName(t.from) || "—")} → ${esc(agentName(toAgent(t.to) || t.to) || "未指定")}</span><span style="margin-left:auto">${dtm(t.created_at)}</span></div>
      <p>${esc(t.text)}</p>${taskActs(t)}</div>`).join("");
    $("#approvals").innerHTML = (ap + tk) || '<div class="empty"><b>没有待批示事项</b>Agent 经 /cmd approval_request 提交后会出现在这里</div>';
    notifyApprovals(n, pend);
  }
  const AP_ST = { pending: "待批示", approved: "已批准", rejected: "已打回", answered: "已批示" };
  const ASSIST = { url: "要一个网址", text: "要一段内容", vault: "申请使用口令" };
  const DEC_CN = { approve: "批准", reject: "打回", comment: "批注", custom: "自定义答复", option: "选择" };
  function apvCard(a) {
    const assist = a.kind === "assist";
    const opts = a.options || [];
    const custom = opts.length && !(opts.length === 2 && opts[0] === "同意" && opts[1] === "驳回");
    let btns = "";
    if (a.status === "pending") {
      if (assist) btns = `<button class="act ok" data-apv="assist" data-id="${a.id}" data-ak="${esc(a.assist_kind || "text")}" type="button">${a.assist_kind === "vault" ? "授权口令…" : a.assist_kind === "url" ? "提供网址…" : "提供内容…"}</button><button class="act no" data-apv="reject" data-id="${a.id}" type="button">驳回</button>`;
      else if (custom) btns = opts.map((o) => `<button class="act ${/驳|拒|否/.test(o) ? "no" : /同意|批准|通过/.test(o) ? "ok" : "gold"}" data-apv="option" data-opt="${esc(o)}" data-id="${a.id}" type="button">${esc(o)}</button>`).join("");
      else btns = `<button class="act ok" data-apv="approve" data-id="${a.id}" type="button">同意</button><button class="act no" data-apv="reject" data-id="${a.id}" type="button">驳回</button>`;
      btns += `<button class="act" data-apv="custom" data-id="${a.id}" type="button">自定义答复</button>`;
    }
    btns += `<button class="act" data-apv="comment" data-id="${a.id}" type="button">批注</button>`;
    return `<div class="apv${a.status !== "pending" ? " done" : ""}" data-requester="${esc(a.requester)}">
      <div class="apv-top"><b>#${a.id} ${esc(a.title)}</b>${assist ? `<span class="kindtag">协助 · ${ASSIST[a.assist_kind] || "协助"}</span>` : ""}<span class="tag ${a.status === "pending" ? "ping" : a.status === "rejected" ? "red" : ""}">${AP_ST[a.status] || a.status}</span><span>${esc(agentName(a.requester))}${a.requester_instance ? " · " + esc(a.requester_instance) : ""}</span>${a.project_id ? `<span class="tag">项目 ${esc(projName(a.project_id))}</span>` : ""}<span style="margin-left:auto">${dtm(a.created_at)}</span></div>
      ${a.detail ? `<p>${esc(a.detail)}</p>` : ""}
      ${a.decision_note && a.status !== "pending" ? `<div class="task-ev"><div>结果：${esc(a.decision_note)}${a.decided_at ? " · " + dtm(a.decided_at) : ""}</div></div>` : ""}
      ${(a.notes || []).length ? `<div class="task-ev">${a.notes.map((x) => `<div>${dtm(x.ts)} · ${DEC_CN[x.decision] || esc(x.decision)}${x.note ? "：" + esc(x.note) : ""}</div>`).join("")}</div>` : ""}
      <div class="acts opts">${btns}</div></div>`;
  }
  function renderAgentApprovals(aid) {
    const box = $("#dr-aps"); if (!box || !S.appr) return;
    const names = new Set([aid].concat(((S.agentById[aid] || {}).instances || []).map((i) => i.name)));
    const list = (S.appr.approvals || []).filter((a) => a.status === "pending" && (names.has(a.requester) || names.has(a.requester_instance)));
    box.innerHTML = list.length ? list.map(apvCard).join("") : '<div class="note">已处理完</div>';
  }
  function taskActs(t) {
    const st = t.status, b = [];
    if (st === "pending" || st === "doing") b.push(`<button class="act ok" data-task-act="task_approve" data-tid="${t.id}" type="button">通过</button>`);
    if (st === "pending" || st === "doing" || st === "failed") b.push(`<button class="act no" data-task-act="task_reject" data-tid="${t.id}" type="button">打回</button>`);
    if (["failed", "dead", "cancelled", "done"].includes(st)) b.push(`<button class="act" data-task-act="task_retry" data-tid="${t.id}" type="button">重跑</button>`);
    if (st !== "doing") b.push(`<button class="act" data-task-act="task_reassign" data-tid="${t.id}" type="button">转交</button>`);
    return `<div class="acts">${b.join("")}</div>`;
  }
  async function onApprovalBtn(btn) {
    const dec = btn.dataset.apv, id = Number(btn.dataset.id);
    if (dec === "assist") return onAssist(btn, id);
    if (dec === "option" || dec === "custom") {
      const isOpt = dec === "option", label = btn.dataset.opt;
      const v = await dlg({ title: isOpt ? `#${id} 选择「${label}」` : `#${id} 自定义答复`, desc: isOpt ? "可选：补一句说明，会随结果推回申请方" : "必填：你的答复原文，会经消息总线推回申请方", required: !isOpt, okText: isOpt ? label : "发送答复" });
      if (!v) return;
      btn.disabled = true;
      await act("approval_decide", isOpt ? { id, decision: "option", option: label, note: v.value } : { id, decision: "custom", note: v.value }, (j) => (j.msg_id ? "已答复并推回 " + agentName(toAgent(j.pushed_to) || j.pushed_to) : "已答复"));
      btn.disabled = false;
      return;
    }
    const T = { approve: ["同意 #" + id, "可选：写一句批注，会随结果推回申请方"], reject: ["驳回 #" + id, "必填：驳回原因 / 修改意见"], comment: ["批注 #" + id, "必填：批注内容（不改变状态）"] }[dec];
    const v = await dlg({ title: T[0], desc: T[1], required: dec !== "approve", okText: dec === "approve" ? "同意" : dec === "reject" ? "驳回" : "发送批注", danger: dec === "reject" });
    if (!v) return;
    btn.disabled = true;
    await act("approval_decide", { id, decision: dec, note: v.value }, (j) => (j.msg_id ? "已裁决，并经消息总线推回 " + agentName(toAgent(j.pushed_to) || j.pushed_to) : "已裁决（" + j.note + "）"));
    btn.disabled = false;
  }
  async function onTaskBtn(btn) {
    const a = btn.dataset.taskAct, tid = Number(btn.dataset.tid);
    const T = { task_approve: ["通过任务 #" + tid, "任务标记完成；可写批注，会推给发起方", false, "通过"], task_reject: ["打回任务 #" + tid, "任务取消并把原因推给发起方", true, "打回"], task_retry: ["重跑任务 #" + tid, "清空租约与重试次数，重新排队", false, "重跑"], task_reassign: ["转交任务 #" + tid, "选择新的执行者；任务回到待办并通知双方", false, "转交"] }[a];
    const v = await dlg({ title: T[0], desc: T[1], required: T[2], okText: T[3], select: a === "task_reassign" ? targets() : null, placeholder: "批注（" + (T[2] ? "必填" : "可选") + "）", danger: a === "task_reject" });
    if (!v) return;
    btn.disabled = true;
    await act(a, { task_id: tid, note: v.value, to: v.target || undefined }, (j) => `任务 #${tid} 已${j.action}`);
    btn.disabled = false;
  }

  /* 审计 */
  const ACT_CN = { msg: "发消息", rollcall: "发起点名", submit: "下指令", pause: "暂停", resume: "恢复", task_approve: "通过任务", task_reject: "打回任务", task_retry: "重跑任务", task_reassign: "转交任务", approval_decide: "审批裁决", kb_save: "编辑知识库", pair: "设备配对", pair_code_create: "生成配对链接", device_revoke: "吊销设备", logout: "退出设备", vault_put: "存入口令", vault_disable: "停用口令", vault_enable: "启用口令", vault_list: "查看口令清单", project_upsert: "编辑项目", phase_upsert: "编辑阶段", phase_accept: "阶段验收" };
  async function loadAudit() {
    try {
      const rows = (await api("/api/audit?limit=50")).data || [];
      $("#audit").innerHTML = rows.length ? rows.map((r) => `<div class="au"><time>${tm(r.ts)}<br>${fmtD.format(new Date(r.ts * 1000)).slice(5)}</time><div><b>${r.actor === OWNER ? "大古" : esc(r.actor)}</b> · ${esc(r.device || "")} · ${esc(ACT_CN[r.action] || r.action)} ${r.target ? "→ " + esc(String(r.target)) : ""} ${r.ok ? "" : '<span class="bad">（未成功）</span>'}<small>${esc(auditSummary(r))}</small></div></div>`).join("")
        : '<div class="empty"><b>还没有写操作</b>配对后的每一次操作都会记在这里</div>';
    } catch (e) { $("#audit").innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; }
  }
  function auditSummary(r) {
    const a = (r.detail && r.detail.args) || {}, res = (r.detail && r.detail.result) || {};
    const parts = [];
    if (a.text) parts.push("内容：" + a.text);
    if (a.note) parts.push("批注：" + a.note);
    if (a.decision) parts.push("裁决：" + (DEC_CN[a.decision] || a.decision) + (a.option ? " " + a.option : ""));
    if (a.name) parts.push("条目：" + a.name);
    if (a.project_id) parts.push("项目：" + a.project_id + (a.seq ? " 阶段 " + a.seq : ""));
    if (a.evidence) parts.push("证据：" + a.evidence);
    if (res.error) parts.push("原因：" + res.error);
    if (res.msg_id) parts.push("消息 " + res.msg_id);
    if (res.task_id && r.action === "submit") parts.push("任务 #" + res.task_id);
    if (r.detail && r.detail.error) parts.push(r.detail.error);
    return parts.join(" · ");
  }

  /* 节点详情里的介入操作 */
  function agentActions(a) {
    const paused = a.status !== "active";
    const insts = (a.instances || []).filter((i) => i.registry_status === "active");
    const to = insts.length ? `<label class="sr" for="cmp-to">发给</label><select id="cmp-to" class="kb-edit" style="min-height:0;height:40px;font-family:var(--font)"><option value="${esc(a.agent_id)}">${esc(a._label)}（${esc(a.agent_id)}）</option>${insts.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join("")}</select>` : `<input type="hidden" id="cmp-to" value="${esc(a.agent_id)}">`;
    return `<div><h4>介入操作 ${own() ? "" : '<span class="lock">· 首次操作需配对本设备</span>'}</h4><div class="compose">${to}
      <label class="sr" for="cmp-text">内容</label><textarea id="cmp-text" rows="3" placeholder="给 ${esc(a._label)} 的消息或指令…"></textarea>
      <div class="acts"><button class="act gold" data-op="msg" type="button">发消息</button><button class="act" data-op="submit" type="button">下指令（入任务队列）</button>
      ${paused ? `<button class="act ok" data-op="resume" type="button">恢复</button>` : `<button class="act no" data-op="pause" type="button">暂停</button>`}</div></div></div>`;
  }
  async function onAgentOp(btn, aid) {
    const op = btn.dataset.op, dr = $("#drawer");
    const to = ($("#cmp-to", dr) || {}).value || aid;
    const text = (($("#cmp-text", dr) || {}).value || "").trim();
    if ((op === "msg" || op === "submit") && !text) { toast("先写内容"); $("#cmp-text", dr).focus(); return; }
    if (op === "pause" || op === "resume") {
      const v = await dlg({ title: (op === "pause" ? "暂停 " : "恢复 ") + agentName(aid) + "？", desc: op === "pause" ? "暂停后它不再领新任务；指挥入口的 /cmd 会被拒绝。随时可恢复。" : "恢复后约 30 秒内重新在岗。", placeholder: "批注（可选）", okText: op === "pause" ? "暂停" : "恢复", danger: op === "pause" });
      if (!v) return;
      btn.disabled = true;
      const j = await act(op, { agent: aid, note: v.value }, (r) => `${agentName(aid)} 已${op === "pause" ? "暂停" : "恢复"}（${r.note || r.status}）`);
      btn.disabled = false;
      if (j && j.ok) setTimeout(() => openAgent(aid), 2600);
      return;
    }
    btn.disabled = true;
    const j = await act(op, { to, text }, (r) => (op === "msg" ? `已发给 ${agentName(toAgent(r.to) || r.to)}（${r.msg_id}）` : `已下指令：任务 #${r.task_id}（${r.type}）`));
    btn.disabled = false;
    if (j && j.ok) $("#cmp-text", dr).value = "";
  }

  /* 知识库编辑 */
  async function editDoc(d) {
    if (d.truncated) { toast("文件过大被截断，控制台不支持编辑"); return; }
    if (!own() && !(await askPair())) return;
    $("#drawer .dr-body").innerHTML = `<label class="sr" for="kb-edit">正文</label><textarea class="kb-edit" id="kb-edit">${esc(d.content)}</textarea>
      <div class="acts"><button class="act gold" id="kb-save" type="button">保存</button><button class="act" id="kb-cancel" type="button">取消</button><span class="note">保存前自动留底到服务器 99-Local/kb-history；若他人已改动会拒绝覆盖</span></div>`;
    $("#kb-cancel").onclick = () => openDoc(d.path);
    $("#kb-save").onclick = async (e) => {
      e.target.disabled = true;
      const j = await act("kb_save", { path: d.path, content: $("#kb-edit").value, base_sha256: d.sha256 }, "已保存");
      e.target.disabled = false;
      if (j && j.ok) openDoc(d.path);
    };
  }

  /* ---------- 指挥官对话（A）：大古 ↔ 幕僚长，SSE 实时 ----------
     发送 = /api/owner/act msg → 消息总线；服务端再经 webhook 转达指挥官（未配置时只入总线）。
     幕僚长用 grok-chief 令牌经 /cmd msg 回复，SSE 推到这里。 */
  const isChat = (m) => (m.from_agent === OWNER && (m.to === CHAT_PEER || S.chatNames.has(m.to))) || (m.from_agent === CHAT_PEER && m.to === OWNER);
  function addChat(m, live) {
    if (!m || !m.msg_id || S.chatIds.has(m.msg_id)) return false;
    S.chatIds.add(m.msg_id);
    m._fresh = !!live;
    S.chat.push(m);
    S.chat.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    if (live && m.from_agent === CHAT_PEER) onChiefReply(m);
    return true;
  }
  async function loadChat(before) {
    try {
      const j = await api(`/api/chat?limit=80${before ? "&before=" + before : ""}`);
      (j.data.names || []).forEach((n) => S.chatNames.add(n));
      S.chatHook = j.data.hook_configured;
      const known = new Map(S.chat.map((m) => [m.msg_id, m]));
      (j.data.messages || []).forEach((m) => { const k = known.get(m.msg_id); if (k) { k.hook = m.hook; } else addChat(m, false); });
      renderChat(!before);
      if (before && !(j.data.messages || []).length) toast("没有更早的消息了");
    } catch (e) { if (!S.chat.length) $("#chat").innerHTML = `<li class="empty">读取失败：${esc(e.message)}</li>`; }
  }
  function hookTag(m) {
    if (m.from_agent !== OWNER) return "";
    if (m.hook && m.hook.sent_at) return `<span class="hook ok" title="已经 webhook 转达指挥官">✓ 已转达</span>`;
    if (m.hook && m.hook.error) return `<span class="hook bad" title="${esc(m.hook.error)}">转达重试中 · ${m.hook.attempts} 次</span>`;
    if (m.hook) return `<span class="hook warn">转达排队中</span>`;
    return S.chatHook === false ? `<span class="hook" title="服务器未配置指挥官 webhook：消息已入总线，等幕僚长下次读取">已入总线</span>` : `<span class="hook">已入总线</span>`;
  }
  function renderChat(stick) {
    const box = $("#chat"); if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const byId = new Map(S.chat.map((m) => [m.msg_id, m]));
    box.innerHTML = S.chat.length ? S.chat.map((m) => {
      const me = m.from_agent === OWNER;
      const sys = me && /^【(审批|协助)/.test(m.text || "");
      const q = m.reply_to && byId.get(m.reply_to);
      return `<li class="bub${me ? " me" : ""}${sys ? " sys" : ""}${m._fresh && !reduced.matches ? " fresh" : ""}" data-mid="${esc(m.msg_id)}">${q ? `<span class="quote">${esc((q.text || "").slice(0, 80))}</span>` : ""}${esc(m.text)}<div class="meta"><time>${dtm(m.created_at)}</time>${me ? "" : `<span>${esc(m.from_instance || "幕僚长")}</span>`}${hookTag(m)}<button type="button" data-chat-reply="${esc(m.msg_id)}">回复</button>${!me && "speechSynthesis" in window ? `<button type="button" data-chat-say="${esc(m.msg_id)}">朗读</button>` : ""}</div></li>`;
    }).join("") : '<li class="empty"><b>还没有对话</b><br>在下面给幕僚长发第一条指令；回复会实时出现在这里</li>';
    S.chat.forEach((m) => { m._fresh = false; });
    if (stick || nearBottom) scrollChat();
    renderChatFoot();
  }
  function scrollChat() { const b = $("#chat"); if (b) b.scrollTop = b.scrollHeight; }
  function renderChatFoot() {
    const el = $("#chat-foot"); if (!el) return;
    const g = S.agentById[CHAT_PEER];
    const so = g ? stateOf(g) : null;
    el.textContent = `幕僚长：${so ? so.text + (so.work ? " · " + so.work : "") : "—"} · ${S.chatHook ? "新消息会经 webhook 即时转达" : "webhook 未配置：消息入总线，等幕僚长读取"}${own() ? "" : " · 首次发送需配对本设备"}`;
  }
  function setChatReply(id) {
    S.chatReply = id || null;
    const box = $("#chat-reply"), m = S.chat.find((x) => x.msg_id === id);
    box.hidden = !m;
    if (m) box.innerHTML = `<span>回复：${esc((m.text || "").slice(0, 60))}</span><button type="button" id="chat-reply-x" aria-label="取消回复">×</button>`;
    if (m) $("#chat-reply-x").onclick = () => setChatReply(null);
    $("#chat-input").focus();
  }
  async function sendChat() {
    const ta = $("#chat-input"), text = ta.value.trim();
    if (!text) return;
    const btn = $("#chat-send"); btn.disabled = true;
    const j = await act("msg", { to: CHAT_PEER, text, reply_to: S.chatReply || undefined });
    btn.disabled = false;
    if (j && j.ok) {
      ta.value = ""; autoGrow(ta); setChatReply(null);
      addChat(Object.assign({ from_agent: OWNER, to: CHAT_PEER, kind: "chat", text, created_at: now() }, j), true);
      renderChat(true);
      setTimeout(() => loadChat(), 2500);
    }
  }
  function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; }
  function renderChatBadge() {
    const b = $("#tab-chat-badge"); if (!b) return;
    b.hidden = !S.chatUnread; b.textContent = S.chatUnread > 99 ? "99+" : S.chatUnread;
    updateAppBadge();
  }
  function onChiefReply(m) {
    const onChat = document.documentElement.dataset.tab === "chat" || !mobile.matches;
    if (!onChat || document.visibilityState !== "visible") { S.chatUnread += 1; renderChatBadge(); }
    if (pref("sound")) beep(880);
    if (pref("tts")) say(m.text);
    localNotify("幕僚长回复", m.text, "chat");
  }

  /* ---------- 提醒（B 回退方案）：页内红点 + 角标 + 提示音 + 本地通知 ----------
     Web Push（后台推送）尚未上线：服务器缺 VAPID 推送库，见报告。页面打开时以下提醒都有效。 */
  const PREF_KEY = "sb.prefs.v1";
  const prefs = () => { try { return Object.assign({ sound: true, tts: false, notify: false }, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch (e) { return { sound: true, tts: false, notify: false }; } };
  const pref = (k) => prefs()[k];
  function setPref(k, v) { const p = prefs(); p[k] = v; localStorage.setItem(PREF_KEY, JSON.stringify(p)); renderTtsBtn(); }
  let actx = null;
  function beep(freq) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = freq || 880; o.type = "sine";
      g.gain.setValueAtTime(0.0001, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.18, actx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.35);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.4);
    } catch (e) { /* 浏览器未允许音频 */ }
  }
  function localNotify(title, body, tag) {
    if (!pref("notify") || !("Notification" in window) || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    try { new Notification(title, { body: String(body || "").slice(0, 120), tag: "sb-" + tag, icon: "v2/icons/icon-192.png" }); } catch (e) { /* iOS 非主屏模式不支持 */ }
  }
  function updateAppBadge() {
    const n = S.chatUnread + (S.apCount || 0);
    document.title = (n ? `(${n}) ` : "") + "Super-Brain · 协作中枢 v2";
    try { if (navigator.setAppBadge) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) { /* 不支持 */ }
  }
  function notifyApprovals(n, pend) {
    const ids = new Set(pend.map((a) => a.id));
    if (S.apPrev) {
      const fresh = pend.filter((a) => !S.apPrev.has(a.id));
      if (fresh.length) { if (pref("sound")) { beep(660); setTimeout(() => beep(990), 180); } localNotify("新的待批示", fresh.map((a) => a.title).join("；"), "ap"); toast(`新的待批示 ${fresh.length} 项`); }
    }
    S.apPrev = ids; S.apCount = n; updateAppBadge();
  }
  function prefRows() {
    const p = prefs();
    const row = (k, t, sub, dis) => `<label class="toggle-row"><span>${t}<small>${sub}</small></span><input type="checkbox" data-pref="${k}" ${p[k] ? "checked" : ""} ${dis ? "disabled" : ""}></label>`;
    return row("sound", "提示音", "新回复 / 新审批时响一声")
      + row("tts", "朗读幕僚长回复", "speechSynthesis（浏览器原生，免费）", !("speechSynthesis" in window))
      + row("notify", "系统通知", "页面在后台但未关闭时弹通知；关掉页面后的推送（Web Push）尚未上线", !("Notification" in window));
  }
  function bindPrefs(dr) {
    $$("[data-pref]", dr).forEach((cb) => { cb.onchange = async () => {
      if (cb.dataset.pref === "notify" && cb.checked && Notification.permission !== "granted") {
        const r = await Notification.requestPermission(); if (r !== "granted") { cb.checked = false; toast("没有获得通知权限"); return; }
      }
      setPref(cb.dataset.pref, cb.checked);
    }; });
  }

  /* ---------- 语音（F）：按住说话 = 浏览器原生 Web Speech（zh-CN）；朗读 = speechSynthesis ----------
     不上传音频到任何付费服务。浏览器不支持时按钮置灰。 */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, recBase = "";
  function micStart(e) {
    e.preventDefault();
    if (!SR) { toast("这个浏览器不支持原生语音识别，请用键盘输入（iPhone 可用输入法自带的麦克风）"); return; }
    if (rec) return;
    rec = new SR(); rec.lang = "zh-CN"; rec.interimResults = true; rec.continuous = true;
    const ta = $("#chat-input"); recBase = ta.value ? ta.value + " " : "";
    rec.onresult = (ev) => { let t = ""; for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; ta.value = recBase + t; autoGrow(ta); };
    rec.onerror = (ev) => { toast("语音识别出错：" + (ev.error || "未知")); micStop(); };
    rec.onend = () => { $("#btn-mic").classList.remove("rec"); rec = null; };
    try { rec.start(); $("#btn-mic").classList.add("rec"); if (navigator.vibrate) navigator.vibrate(20); } catch (err) { rec = null; }
  }
  function micStop() { if (rec) { try { rec.stop(); } catch (e) { /* noop */ } } }
  function say(text) {
    if (!("speechSynthesis" in window) || !text) return;
    const u = new SpeechSynthesisUtterance(String(text).replace(/https?:\/\/\S+/g, "链接").slice(0, 500));
    u.lang = "zh-CN"; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find((x) => /zh[-_]CN/i.test(x.lang)); if (v) u.voice = v;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function renderTtsBtn() {
    const b = $("#btn-tts"); if (!b) return;
    const on = pref("tts"); b.textContent = on ? "朗读 开" : "朗读 关"; b.setAttribute("aria-pressed", on ? "true" : "false");
    b.classList.toggle("chip-gold", on);
    if (!("speechSynthesis" in window)) { b.disabled = true; b.title = "此浏览器不支持朗读"; }
  }

  /* ---------- 项目（地基）：完成度 = 已验收且已核实阶段 / 全部阶段；未核实单列 ---------- */
  const PH = { pending: "未开始", in_progress: "进行中", blocked: "阻塞", accepted: "已验收" };
  const projName = (id) => ((S.projects || []).find((p) => p.id === id) || {}).name || id;
  async function loadProjects() {
    try { S.projects = (await api("/api/projects")).data || []; renderProjects(); }
    catch (e) { $("#projects").innerHTML = `<div class="empty" role="alert"><b>读取失败</b>${esc(e.message)}</div>`; }
  }
  const msBar = (p) => `<div class="ms" aria-label="阶段进度">${p.phases.map((x) => `<i class="${x.status === "accepted" ? (x.verified ? "acc" : "unv") : x.status === "in_progress" ? "doing" : x.status === "blocked" ? "blk" : ""}" title="${esc(x.seq + ". " + x.name + " · " + (PH[x.status] || x.status) + (x.status === "accepted" && !x.verified ? "（未核实）" : ""))}"></i>`).join("")}</div>`;
  function renderProjects() {
    const list = S.projects || [];
    $("#projects").innerHTML = list.length ? list.map((p) => `<button class="pj" data-pj="${esc(p.id)}" type="button">
      ${p.pending_approvals ? `<span class="rdot" title="待审批 ${p.pending_approvals}">${p.pending_approvals}</span>` : ""}
      <div class="pj-top"><b>${esc(p.name)}</b><span class="pj-pct">${p.completion}<small>%</small></span></div>
      ${msBar(p)}
      <div class="pj-sub">已验收 <b>${p.accepted_verified}/${p.phase_total}</b>${p.accepted_unverified ? ` · <span style="color:#ffd38a">另 ${p.accepted_unverified} 项未核实</span>` : ""} · 当前：<b>${esc(p.current_phase ? p.current_phase.name : "全部完成")}</b></div>
      <div class="ppl">${(p.agents || []).map((a) => `<span>${esc(agentName(a))}</span>`).join("")}</div>
      ${p.blocked.length ? `<div class="blk">阻塞：${p.blocked.map((b) => esc(b.name + (b.blocker ? "（" + b.blocker + "）" : ""))).join("；")}</div>` : ""}
      ${p.constraints ? `<div class="pj-sub" style="color:var(--ink3)">约束：${esc(p.constraints)}</div>` : ""}</button>`).join("")
      : '<div class="empty"><b>还没有项目</b>点「新建项目」开始</div>';
  }
  function openProject(id) {
    const p = (S.projects || []).find((x) => x.id === id); if (!p) return;
    const tl = p.phases.map((x) => `<div class="tl-it" data-s="${x.status}" data-v="${x.verified ? 1 : 0}"><span class="tl-dot">${x.status === "accepted" ? "✓" : x.seq}</span><div class="tl-b">
      <b>${x.seq}. ${esc(x.name)}</b> <span class="st ${x.status === "accepted" ? "idle" : x.status === "in_progress" ? "busy" : x.status === "blocked" ? "offline" : "unused"}">${PH[x.status] || x.status}</span>${x.status === "accepted" && !x.verified ? '<span class="unv-tag">未核实</span>' : ""}
      ${x.deliverable ? `<p>产出：${esc(x.deliverable)}</p>` : ""}${x.acceptance ? `<p>验收：${esc(x.acceptance)}</p>` : ""}
      ${x.evidence ? `<p class="ev">证据：${esc(x.evidence)}</p>` : ""}${x.blocker ? `<p style="color:#ff9aa4">阻塞：${esc(x.blocker)}</p>` : ""}
      <p class="ev">${x.accepted_at ? "验收于 " + dtm(x.accepted_at) + " · " : ""}更新 ${dtm(x.updated_at)} · ${esc(x.updated_by === OWNER ? "大古" : x.updated_by === "seed" ? "初始登记" : agentName(x.updated_by))}</p>
      <div class="acts">${x.status !== "accepted" || !x.verified ? `<button class="act ok" data-ph="accept" data-pj="${esc(p.id)}" data-seq="${x.seq}" type="button">验收（附证据）</button>` : ""}${x.status !== "in_progress" ? `<button class="act" data-ph="in_progress" data-pj="${esc(p.id)}" data-seq="${x.seq}" type="button">标进行中</button>` : ""}${x.status !== "blocked" ? `<button class="act no" data-ph="blocked" data-pj="${esc(p.id)}" data-seq="${x.seq}" type="button">标阻塞</button>` : ""}<button class="act" data-ph="evidence" data-pj="${esc(p.id)}" data-seq="${x.seq}" type="button">补证据/说明</button></div>
      </div></div>`).join("");
    const aps = S.appr ? (S.appr.approvals || []).filter((a) => a.project_id === p.id && a.status === "pending") : [];
    openDrawer(head(esc(p.name), `完成度 <b>${p.completion}%</b>（已验收且核实 ${p.accepted_verified}/${p.phase_total}${p.accepted_unverified ? `，另 ${p.accepted_unverified} 项未核实，含则 ${p.completion_incl_unverified}%` : ""}）`, "var(--gold)") + `<div class="dr-body">
      ${msBar(p)}
      <dl class="kv"><dt>负责人</dt><dd>${esc(agentName(p.owner))}</dd><dt>参与</dt><dd>${(p.agents || []).map((a) => esc(agentName(a))).join("、") || "—"}</dd><dt>约束</dt><dd>${esc(p.constraints || "—")}</dd><dt>说明</dt><dd>${esc(p.summary || "—")}</dd></dl>
      ${aps.length ? `<div><h4>待审批 <span class="tag red">${aps.length}</span></h4><div class="list">${aps.map(apvCard).join("")}</div></div>` : ""}
      <div><h4>阶段时间线</h4><div class="tl">${tl || '<div class="note">还没有阶段</div>'}</div></div>
      <div class="acts"><button class="act gold" data-ph="new" data-pj="${esc(p.id)}" data-seq="${(p.phases.reduce((m, x) => Math.max(m, x.seq), 0) || 0) + 1}" type="button">新增阶段</button></div>
      <div class="note">完成度只按阶段验收真实计算；「未核实」= 据记录已完成但控制台没有证据，验收时补上证据即转为已核实。写操作需配对，大古与幕僚长（/cmd phase_accept 等）都可编辑，全部记审计。</div></div>`);
  }
  async function onPhaseBtn(b) {
    const pid = b.dataset.pj, seq = Number(b.dataset.seq), k = b.dataset.ph;
    let j = null;
    if (k === "accept") {
      const v = await dlg({ title: `验收阶段 ${seq}`, desc: "必填：证据（PR 链接、页面地址、截图路径或核验记录）。验收后计入完成度。", required: true, okText: "验收" });
      if (!v) return; j = await act("phase_accept", { project_id: pid, seq, evidence: v.value }, "已验收");
    } else if (k === "blocked") {
      const v = await dlg({ title: `阶段 ${seq} 标阻塞`, desc: "必填：卡在哪里、等谁", required: true, okText: "标阻塞", danger: true });
      if (!v) return; j = await act("phase_upsert", { project_id: pid, seq, status: "blocked", blocker: v.value }, "已标阻塞");
    } else if (k === "in_progress") {
      j = await act("phase_upsert", { project_id: pid, seq, status: "in_progress", blocker: "" }, "已标进行中");
    } else if (k === "evidence") {
      const v = await dlg({ title: `阶段 ${seq} 补证据/说明`, desc: "不改变状态", required: true, okText: "保存" });
      if (!v) return; j = await act("phase_upsert", { project_id: pid, seq, evidence: v.value }, "已保存");
    } else if (k === "new") {
      const v = await dlg({ title: "新增阶段", desc: "第一行：阶段名；第二行（可选）：产出；第三行（可选）：验收标准", required: true, okText: "新增", rows: 4 });
      if (!v) return; const [name, deliverable, acceptance] = v.value.split("\n").map((x) => x.trim());
      j = await act("phase_upsert", { project_id: pid, seq, name, deliverable, acceptance }, "已新增阶段");
    }
    if (j && j.ok) { await loadProjects(); openProject(pid); }
  }
  async function newProject() {
    const v = await dlg({ title: "新建项目", desc: "第一行：项目名；第二行：英文 id（小写字母/数字/-）；第三行（可选）：参与 Agent id，逗号分隔；第四行（可选）：约束", required: true, rows: 5, okText: "创建" });
    if (!v) return;
    const [name, id, agents, constraints] = v.value.split("\n").map((x) => (x || "").trim());
    const j = await act("project_upsert", { id, name, agents: agents ? agents.split(/[,，\s]+/).filter(Boolean) : [], constraints }, "项目已创建");
    if (j && j.ok) { await loadProjects(); openProject(id); }
  }

  /* ---------- 口令包（C）：只管名称/用途；值只在存入时输入一次，永不回显 ---------- */
  async function loadVault(dr) {
    const box = $("#st-vault", dr); if (!box) return;
    const o = own(); if (!o) return;
    const j = await postJSON("/api/owner/act", { action: "vault_list", args: {} }, o.token);
    if (!j.ok) { box.innerHTML = `<div class="note">${esc(j.error || "读取失败")}</div>`; return; }
    if (!j.available) { box.innerHTML = '<div class="note">服务器缺加密库，口令包不可用</div>'; return; }
    box.innerHTML = (j.items || []).map((it) => `<div class="vault-it"><b>${esc(it.name)}</b><small>${esc(it.purpose || "")} · 更新 ${dtm(it.updated_at)}${it.disabled ? " · 已停用" : ""}</small><button class="act ${it.disabled ? "ok" : "no"}" data-vault-tog="${esc(it.name)}" data-dis="${it.disabled ? 0 : 1}" type="button">${it.disabled ? "启用" : "停用"}</button></div>`).join("") || '<div class="note">还没有口令条目</div>';
    $$("[data-vault-tog]", box).forEach((b) => { b.onclick = async () => {
      const j2 = await act(b.dataset.dis === "1" ? "vault_disable" : "vault_enable", { name: b.dataset.vaultTog }, "已更新"); if (j2 && j2.ok) loadVault(dr); }; });
    $("#st-vault-add", dr).onclick = () => vaultAdd(dr);
  }
  async function vaultAdd(dr) {
    const d = $("#dlg");
    $("#dlg-title").textContent = "存入 / 更新口令";
    $("#dlg-desc").textContent = "值用 AES-GCM 加密存在服务器，主密钥单独保存。页面、日志、消息里都不会再出现这个值；Agent 只能在你批准后凭限时限次票据取用。";
    $("#dlg-extra").innerHTML = `<div class="fld"><label for="vf-name">名称（英文/中文，不含空格）</label><input id="vf-name" type="text" autocomplete="off" maxlength="60"></div><div class="fld"><label for="vf-purpose">用途</label><input id="vf-purpose" type="text" autocomplete="off" maxlength="200"></div><div class="fld"><label for="vf-val">值（输入后不回显）</label><input id="vf-val" type="password" autocomplete="new-password"></div>`;
    $("#dlg-input").hidden = true;
    const ok = $("#dlg-ok"); ok.textContent = "加密存入"; ok.className = "btn";
    const res = await new Promise((resolve) => {
      const done = (v) => { d.close(); $("#dlg-form").onsubmit = null; $("#dlg-cancel").onclick = null; d.oncancel = null; resolve(v); };
      $("#dlg-form").onsubmit = (e) => { e.preventDefault(); done({ name: $("#vf-name").value.trim(), purpose: $("#vf-purpose").value.trim(), value: $("#vf-val").value }); };
      $("#dlg-cancel").onclick = () => done(null); d.oncancel = () => done(null);
      d.showModal ? d.showModal() : d.setAttribute("open", ""); setTimeout(() => $("#vf-name").focus(), 30);
    });
    $("#dlg-extra").innerHTML = "";
    if (!res || !res.name || !res.value) { if (res) toast("名称和值都要填"); return; }
    const j = await act("vault_put", res, (r) => (r.updated ? "已更新" : "已加密存入") + "：" + r.name);
    res.value = "";
    if (j && j.ok) loadVault(dr);
  }
  async function onAssist(btn, id) {
    const ak = btn.dataset.ak;
    if (ak === "vault") {
      const o = own(); if (!o && !(await askPair())) return;
      const j = await postJSON("/api/owner/act", { action: "vault_list", args: {} }, own().token);
      const items = (j.items || []).filter((x) => !x.disabled);
      if (!items.length) { toast("口令包里还没有可授权的条目，先在「设备与权限」里存入"); return; }
      const v = await dlg({ title: `#${id} 授权使用口令`, desc: "只把「名称」授权给申请方：它凭票据（默认 1 小时、1 次）用自己的令牌取值，全程审计。可在下面写批注。", select: items.map((x) => ({ value: x.name, label: `${x.name} · ${x.purpose || ""}` })), placeholder: "批注（可选）", rows: 2, okText: "授权" });
      if (!v) return;
      btn.disabled = true;
      await act("approval_decide", { id, decision: "approve", vault_item: v.target, ttl: 3600, uses: 1, note: v.value }, "已授权，票据已推给申请方（不含口令值）");
      btn.disabled = false;
      return;
    }
    const v = await dlg({ title: `#${id} ${ak === "url" ? "提供网址" : "提供内容"}`, desc: ak === "url" ? "填 http(s):// 开头的网址，会经消息总线推回申请方" : "填要给申请方的内容（不要填密码，密码请走口令包）", required: true, okText: "发送", rows: ak === "url" ? 2 : 4 });
    if (!v) return;
    btn.disabled = true;
    await act("approval_decide", { id, decision: "approve", reply: v.value }, "已回复申请方");
    btn.disabled = false;
  }

  function bindExtras() {
    $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
    const ta = $("#chat-input");
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !mobile.matches) { e.preventDefault(); sendChat(); } });
    $("#chat").addEventListener("click", (e) => {
      const r = e.target.closest("[data-chat-reply]"); if (r) { setChatReply(r.dataset.chatReply); return; }
      const s2 = e.target.closest("[data-chat-say]"); if (s2) { const m = S.chat.find((x) => x.msg_id === s2.dataset.chatSay); if (m) say(m.text); }
    });
    $("#btn-chat-more").addEventListener("click", () => loadChat(S.chat.length ? S.chat[0].created_at : undefined));
    $("#btn-tts").addEventListener("click", () => { setPref("tts", !pref("tts")); if (pref("tts")) say("朗读已打开"); });
    renderTtsBtn();
    const mic = $("#btn-mic");
    if (!SR) { mic.disabled = true; mic.title = "此浏览器不支持原生语音识别（可用输入法自带的麦克风）"; }
    mic.addEventListener("pointerdown", micStart);
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => mic.addEventListener(ev, micStop));
    $("#projects").addEventListener("click", (e) => { const b = e.target.closest("[data-pj]"); if (b) openProject(b.dataset.pj); });
    $("#btn-new-project").addEventListener("click", newProject);
    $("#agents").addEventListener("click", (e) => {
      const d = e.target.closest("[data-ap-agent]"); if (!d) return;
      e.stopPropagation(); openAgent(d.dataset.apAgent).then(() => { const x = $("#dr-aps"); if (x) x.scrollIntoView({ block: "start" }); });
    }, true);
  }

  /* ---------- 交互绑定 ---------- */
  function setTab(tab) {
    document.documentElement.dataset.tab = tab;
    $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (tab === "overview" && S.view) setTimeout(() => S.graph && S.view.setData(S.graph), 30);
    if (tab === "chat") { S.chatUnread = 0; renderChatBadge(); setTimeout(scrollChat, 30); }
  }
  function go(target) {
    const map = { approvals: ["approvals", "#sec-approvals"], agents: ["more", "#sec-agents"], "agents-issue": ["more", "#sec-agents"], feed: ["feed", ".feed"], "feed-event": ["feed", ".feed"], rollcall: ["overview", "#sec-rollcall"], server: ["more", "#sec-server"], chat: ["chat", "#sec-chat"], projects: ["projects", "#sec-projects"] };
    const [tab, sel] = map[target] || ["overview", "#kpis"];
    if (target === "agents-issue") { S.agentFilter = "issue"; $$("#agent-filter button").forEach((b) => b.classList.toggle("on", b.dataset.f === "issue")); renderAgents(); }
    if (target === "feed-event") { S.feedFilter = "event"; $$("#feed-filter button").forEach((b) => b.classList.toggle("on", b.dataset.f === "event")); renderFeed(); }
    if (mobile.matches) setTab(tab);
    else $(sel).scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
  }
  function bind() {
    $("#kpis").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go); });
    $("#feed-filter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.feedFilter = b.dataset.f; $$("#feed-filter button").forEach((x) => x.classList.toggle("on", x === b)); renderFeed(); });
    $("#agent-filter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.agentFilter = b.dataset.f; $$("#agent-filter button").forEach((x) => x.classList.toggle("on", x === b)); renderAgents(); });
    $("#agents").addEventListener("click", (e) => { const b = e.target.closest("[data-agent]"); if (b) openNode(b.dataset.agent); });
    bindExtras();
    $("#feed").addEventListener("click", (e) => { const li = e.target.closest(".fi"); if (li) openFeedItem(li.dataset.id); });
    $("#feed").addEventListener("keydown", (e) => { if (e.key === "Enter") { const li = e.target.closest(".fi"); if (li) openFeedItem(li.dataset.id); } });
    $("#kb").addEventListener("click", (e) => { const b = e.target.closest("[data-path]"); if (b) openDoc(b.dataset.path); });
    $("#kb-form").addEventListener("submit", (e) => { e.preventDefault(); searchKb($("#kb-q").value.trim()); });
    $("#drawer").addEventListener("click", (e) => {
      const ap = e.target.closest("[data-apv]"); if (ap) { onApprovalBtn(ap); return; }
      const ph = e.target.closest("[data-ph]"); if (ph) { onPhaseBtn(ph); return; }
      const ta = e.target.closest("[data-task-act]"); if (ta) { onTaskBtn(ta); return; }
      const b = e.target.closest("[data-task]"); if (b) toggleTask(b);
    });
    $("#approvals").addEventListener("click", (e) => {
      const a = e.target.closest("[data-apv]"); if (a) { onApprovalBtn(a); return; }
      const t = e.target.closest("[data-task-act]"); if (t) onTaskBtn(t);
    });
    $("#owner-pill").addEventListener("click", settings);
    $("#btn-rollcall").addEventListener("click", async () => {
      const v = await dlg({ title: "发起点名", desc: "以大古身份向全体广播 kind=ping；各节点的回复耗时会出现在「点名历史」。", value: "在的回复 1", rows: 2, okText: "广播" });
      if (!v) return;
      await act("rollcall", { text: v.value || "在的回复 1" }, (j) => "点名已广播：" + j.msg_id);
    });
    $("#scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").getAttribute("aria-hidden") === "false") closeDrawer(); });
    $("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });
    $("#btn-reset").addEventListener("click", () => { if (S.view) S.view.reset(); });
    $("#btn-mode").addEventListener("click", () => {
      const next = S.viewKind === "3d" ? "lite" : "3d";
      if (next === "3d" && !webglOK()) { toast("此设备不支持 WebGL，保持平面模式"); return; }
      localStorage.setItem("sb.view", next); S.view && S.view.dispose(); S.view = null; S.viewKind = null; ensureView();
    });
    $("#legend").addEventListener("click", (e) => { if (e.target.closest("summary")) { const lg = $("#legend"); lg.dataset.collapsed = lg.dataset.collapsed === "true" ? "false" : "true"; renderLegend(); } });
    mobile.addEventListener && mobile.addEventListener("change", () => { if (!localStorage.getItem("sb.view")) { S.view && S.view.dispose(); S.view = null; S.viewKind = null; ensureView(); } renderLegend(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { loadDash(false); if (!S.es || S.es.readyState === 2) { S.esFails = 0; startStream(); } }
    });
    window.addEventListener("online", () => { S.esFails = 0; startStream(); toast("网络已恢复，重新连上实时通道"); });
    window.addEventListener("offline", () => setConn("down", "网络断开"));
  }
  function clock() {
    const el = $("#clock");
    el.firstChild.nodeValue = fmtT.format(new Date((Math.floor(Date.now() / 1000) + S.skew) * 1000));
  }

  function init() {
    bind();
    setInterval(clock, 1000); clock();
    loadDash(true);
    renderOwnerPill(); checkPairHash();
    loadServer(); loadRelations(); loadEvents(); searchKb(""); loadApprovals(); loadAudit(); loadChat(); loadProjects();
    if (!mobile.matches) document.documentElement.dataset.tab = "overview";
    setInterval(() => { if (document.visibilityState === "visible") loadProjects(); }, 60000);
    setInterval(() => { if (document.visibilityState === "visible" && S.mode !== "live") loadChat(); }, 15000);
    setInterval(() => { if (document.visibilityState === "visible") { loadApprovals(); loadAudit(); } }, 20000);
    setInterval(() => { if (document.visibilityState === "visible") loadDash(false); }, 20000);
    setInterval(() => { if (document.visibilityState === "visible") loadServer(); }, 60000);
    setInterval(() => { if (document.visibilityState === "visible") loadRelations(); }, 120000);
    setInterval(() => { if (document.visibilityState === "visible") { renderTicker(); renderAgents(); renderChatFoot(); } }, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.SB = { state: S };
})();
