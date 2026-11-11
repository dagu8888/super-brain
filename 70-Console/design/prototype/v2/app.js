/* Super-Brain 协作中枢 v2（只读）
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
  const LIVE = { working: "执行中", idle: "在线", offline: "离线", unused: "未接入", disabled: "已停用" };
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
  const whoCls = (id) => (id === HUB ? "h" : (S.agentById[id] || {}).kind === "worker" ? "w" : "c");
  const toAgent = (name) => (S.agentById[name] ? name : S.instMap[name] || null);
  const liveOf = (a) => (a.status !== "active" ? "disabled" : a.live_status);

  /* ---------- 连接状态 ---------- */
  function setConn(mode, text) {
    S.mode = mode;
    const el = $("#conn");
    el.dataset.s = mode === "live" ? "live" : mode === "down" ? "bad" : mode === "idle" ? "idle" : "warn";
    el.querySelector("b").textContent = text;
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
    renderKpis(); renderRollcalls(); renderAgents(); renderFeed(); buildGraph(); renderTicker();
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
      <button class="kpi" style="--accent:#9b8cff" data-go="feed-event" type="button">
        <div class="k-label">中台事件</div>
        <div class="k-val"><span data-k="e1">${k.events_1h}</span><small>/ 1 小时</small></div>
        <div class="k-sub">近 24 小时 <b>${k.events_24h}</b><br>队列 待办 <b>${k.queue.pending || 0}</b> · 执行中 <b>${k.queue.doing || 0}</b> · 完成 <b>${big(k.queue.done || 0)}</b></div></button>
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
      const lv = liveOf(a);
      return `<button class="ag" data-agent="${esc(a.agent_id)}" type="button">
        <div class="ag-top"><span class="ag-dot" style="background:${dotColor(a)};box-shadow:0 0 8px ${dotColor(a)}"></span><span class="ag-name">${esc(a._label)}</span><span class="st ${lv}">${LIVE[lv]}</span></div>
        <div class="ag-id">${esc(a.agent_id)}${(a.instances || []).length ? " · " + a.instances.length + " 个实例" : ""}</div>
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
      <div class="tk-row"><span>实时通道</span><b>${S.mode === "live" ? "SSE 已连" : S.mode === "warn" ? "降级" : "—"}</b></div>
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
    d.agents.filter((a) => a.status === "active").forEach((a) => {
      nodes.push({ id: a.agent_id, label: a._label, kind: a.kind, live: a.live_status, working: a.live_status === "working",
        weight: (vol[a.agent_id] || 0) + (rel[a.agent_id] || 0), msgs: vol[a.agent_id] || 0, tasks: rel[a.agent_id] || 0,
        anomalies: a.anomalies, presence_at: a.presence_at, instances: a.instances });
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
      <div class="lg"><span class="dot" style="background:var(--red)"></span>红角标：异常数</div>
      <div class="lt">节点大小 = 24h 消息 + 任务量；亮度 = 在线（5 分钟内心跳）。没有消息时画面静止，不做假动态。</div>`;
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
    openDrawer(head(esc(a._label), `${esc(a.agent_id)} · ${a.kind === "chief" ? "指挥入口" : "执行者"} · <span class="st ${lv}">${LIVE[lv]}</span>`, dot) + `<div class="dr-body">
      <div class="stats4"><div><b>${ago(a.presence_at)}</b><span>最近在场（${esc(a.presence_via || "无")}）</span></div><div><b>${(a.instances || []).filter((i) => i.online).length}/${(a.instances || []).length}</b><span>实例心跳正常</span></div><div><b style="color:${a.anomalies.total ? "#ff9aa4" : "inherit"}">${big(a.anomalies.total)}</b><span>异常合计</span></div><div><b>${(a.doing_task_ids || []).length}</b><span>执行中任务（租约）</span></div></div>
      <div><h4>异常计数</h4><div class="an">${anChips(a.anomalies)}</div></div>
      ${inst ? `<div><h4>实例与心跳</h4><div class="list">${inst}</div></div>` : ""}
      <div><h4>最近消息</h4><div class="list" id="dr-msgs"><div class="note"><span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span> 读取中</div></div></div>
      <div><h4>任务轨迹</h4><div class="list" id="dr-tasks"><div class="note">读取中</div></div></div>
      <div class="note">“在线”只认 5 分钟内心跳 / 在场信号；“执行中”只认任务租约，心跳不算在干活。</div></div>`);
    const [m, t] = await Promise.allSettled([api(`/api/messages?agent=${encodeURIComponent(id)}&limit=30`), api(`/api/agents/${encodeURIComponent(id)}`)]);
    const mb = $("#dr-msgs"), tb = $("#dr-tasks");
    if (mb) mb.innerHTML = m.status === "fulfilled" ? ((m.value.data || []).map((x) => `<div class="li"><div class="li-top"><time>${dtm(x.created_at)}</time><span class="who ${whoCls(x.from_agent)}">${esc(agentName(x.from_agent))}</span><span class="arrow">→</span><span class="who">${esc(agentName(toAgent(x.to) || x.to))}</span>${x.kind === "ping" ? '<span class="tag ping">点名</span>' : x.reply_to ? '<span class="tag">回复</span>' : ""}</div><div class="fi-text">${esc(x.text)}</div></div>`).join("") || '<div class="note">没有收发记录</div>') : `<div class="note">读取失败：${esc(m.reason && m.reason.message)}</div>`;
    if (tb) {
      if (t.status !== "fulfilled") { tb.innerHTML = `<div class="note">读取失败：${esc(t.reason && t.reason.message)}</div>`; return; }
      const rt = t.value.data.recent_tasks || [];
      tb.innerHTML = rt.length ? rt.map((r) => `<button class="li" style="text-align:left" data-task="${r.id}" type="button"><div class="li-top"><b style="color:var(--ink)">#${r.id}</b><span class="tag">${esc(r.type)}</span><span class="st ${r.status === "done" ? "idle" : r.status === "doing" ? "working" : r.status === "pending" ? "unused" : "offline"}">${TASK[r.status] || r.status}</span><time style="margin-left:auto">${dtm(r.done_at || r.claimed_at || r.created_at)}</time></div><div class="fi-text">${esc(r.instruction || r.summary || "")}</div><div class="task-ev" hidden></div></button>`).join("") : '<div class="note">这个 Agent 名下没有认领过的任务（指挥入口通常只发指令、不领任务）</div>';
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
      $("#drawer .dr-body").innerHTML = `<div class="doc">${esc(d.content)}</div>`;
    } catch (e) { $("#drawer .dr-body").innerHTML = `<div class="note" role="alert">读取失败：${esc(e.message)}</div>`; }
  }

  /* ---------- 交互绑定 ---------- */
  function setTab(tab) {
    document.documentElement.dataset.tab = tab;
    $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (tab === "overview" && S.view) setTimeout(() => S.graph && S.view.setData(S.graph), 30);
  }
  function go(target) {
    const map = { agents: ["agents", "#sec-agents"], "agents-issue": ["agents", "#sec-agents"], feed: ["feed", ".feed"], "feed-event": ["feed", ".feed"], rollcall: ["overview", "#sec-rollcall"], server: ["server", "#sec-server"] };
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
    $("#feed").addEventListener("click", (e) => { const li = e.target.closest(".fi"); if (li) openFeedItem(li.dataset.id); });
    $("#feed").addEventListener("keydown", (e) => { if (e.key === "Enter") { const li = e.target.closest(".fi"); if (li) openFeedItem(li.dataset.id); } });
    $("#kb").addEventListener("click", (e) => { const b = e.target.closest("[data-path]"); if (b) openDoc(b.dataset.path); });
    $("#kb-form").addEventListener("submit", (e) => { e.preventDefault(); searchKb($("#kb-q").value.trim()); });
    $("#drawer").addEventListener("click", (e) => { const b = e.target.closest("[data-task]"); if (b) toggleTask(b); });
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
    loadServer(); loadRelations(); loadEvents(); searchKb("");
    setInterval(() => { if (document.visibilityState === "visible") loadDash(false); }, 20000);
    setInterval(() => { if (document.visibilityState === "visible") loadServer(); }, 60000);
    setInterval(() => { if (document.visibilityState === "visible") loadRelations(); }, 120000);
    setInterval(() => { if (document.visibilityState === "visible") { renderTicker(); renderAgents(); } }, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.SB = { state: S };
})();
