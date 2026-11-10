/* Super-Brain 多 Agent 操作台 v1
   范式：LangSmith 的 trace 时间线（任务=一条 span，展开看输入/留痕/输出）
         + CrewAI / AutoGen Studio 的 Agent 看板。
   只读。2026-11-11 起无需口令，打开即可查看。全程最多一条 SSE，失败则 6 秒轮询。 */
"use strict";

const OFFLINE_S = 300;
const API = location.protocol === "http:" || location.protocol === "https:"
  ? ""
  : "http://8.218.106.225:18765";

const NAV = [
  ["overview", "总览"],
  ["agents", "Agent"],
  ["tasks", "任务"],
  ["knowledge", "知识库"],
  ["network", "协作"],
];
const TITLES = { overview: "总览", agents: "Agent 看板", tasks: "任务", knowledge: "知识库", network: "协作网络" };
const STATUS_LABEL = { working: "工作中", idle: "空闲", offline: "离线", unused: "久未使用" };
const TASK_LABEL = {
  pending: "待办", doing: "执行中", done: "已完成",
  failed: "失败", dead: "死信", cancelled: "已取消",
};
const ROLE = {
  "knowledge-worker": "知识整理", "archive-worker": "归档",
  "research-worker": "研究", "analysis-worker": "分析",
  "chat-worker": "对话", "code-worker": "代码", "trae-developer": "开发",
};

const state = {
  serverNow: 0,
  serverNowAt: 0,
  consoleRev: 0,
  overview: null,
  agents: [],
  monitor: null,
  doing: [],
  events: [],
  seen: new Set(),
  lastEventTs: 0,
  relations: null,
  knowledge: null,
  doc: null,
  es: null,
  poll: null,
  slow: null,
  sseErrors: 0,
  mode: "idle",
  agentFilter: { status: "all", kind: "all", q: "" },
  taskFilter: { status: "all", agent: "", q: "", offset: 0 },
  taskPage: null,
  knowQ: "",
  drawerSeq: 0,
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function nowSec() {
  if (!state.serverNow) return Date.now() / 1000;
  return state.serverNow + (Date.now() - state.serverNowAt) / 1000;
}
function stampServer(ts) {
  if (!ts) return;
  state.serverNow = ts;
  state.serverNowAt = Date.now();
}
function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function rel(ts) {
  if (!ts) return "从未";
  const s = Math.max(0, Math.floor(nowSec() - ts));
  if (s < 15) return "刚刚";
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function roleOf(a) {
  if (ROLE[a.agent_id]) return ROLE[a.agent_id];
  return a.kind === "chief" ? "幕僚长" : "执行者";
}
function seenAt(a) {
  const xs = [];
  if (a.presence_at) xs.push(+a.presence_at);
  if (a.last_seen) xs.push(+a.last_seen);
  (a.instances || []).forEach((i) => { if (i.heartbeat_at) xs.push(+i.heartbeat_at); });
  const hb = ((state.monitor && state.monitor.heartbeats) || [])
    .find((h) => h.agent === a.agent_id || h.agent_ref === a.agent_id);
  if (hb && hb.ts) xs.push(+hb.ts);
  return xs.length ? Math.max(...xs) : null;
}
function statusOf(a) {
  const seen = seenAt(a);
  const busy = !!(a.current_task_id || (a.current_task && a.current_task.id));
  if (!seen) return "unused";
  if (nowSec() - seen > OFFLINE_S) return "offline";
  return busy ? "working" : "idle";
}
function statusPill(st) {
  return `<span class="sb-status" data-status="${esc(st)}">${esc(STATUS_LABEL[st] || st)}</span>`;
}
function taskPill(st) {
  const map = { doing: "working", done: "completed", failed: "failed", dead: "error", pending: "waiting", cancelled: "cancelled" };
  return `<span class="sb-status" data-status="${map[st] || "idle"}">${esc(TASK_LABEL[st] || st)}</span>`;
}

function setConn(kind, text, hint) {
  state.mode = kind;
  const el = $("#conn-state");
  if (!el) return;
  el.dataset.status = kind === "push" ? "working" : kind === "poll" ? "waiting" : kind === "error" ? "error" : "idle";
  el.textContent = text;
  el.title = hint || "";
}
function setHealth(monitor) {
  const el = $("#health-pill");
  if (!el) return;
  const alerts = monitor && monitor.health && Array.isArray(monitor.health.alerts) ? monitor.health.alerts : null;
  if (!monitor || !monitor.health) {
    el.dataset.status = "idle";
    el.textContent = "无巡检记录";
    return;
  }
  if (!alerts.length) {
    el.dataset.status = "completed";
    el.textContent = "巡检无告警";
    return;
  }
  el.dataset.status = "waiting";
  el.textContent = "巡检有 " + alerts.length + " 条提示";
  el.title = alerts.join("\n");
}

async function apiGet(path) {
  const res = await fetch(API + path);
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok || !body || body.ok === false) {
    const err = new Error((body && body.error) || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  if (body.ts) stampServer(body.ts);
  return body;
}

function applyDoing(agents, doing) {
  const map = {};
  (doing || []).forEach((t) => { if (t.lease_owner && !map[t.lease_owner]) map[t.lease_owner] = t; });
  agents.forEach((a) => {
    const t = map[a.agent_id];
    if (!t) return;
    if (!a.current_task_id) a.current_task_id = t.id;
    if (!a.current_task) {
      a.current_task = { id: t.id, type: t.type, instruction: (t.summary || "").slice(0, 180) };
    }
  });
}

async function refreshStatus() {
  const [ov, agents, monitor, doing] = await Promise.all([
    apiGet("/api/overview"),
    apiGet("/api/agents"),
    apiGet("/api/monitor").catch((e) => { if (e.status === 401) throw e; return { data: null }; }),
    apiGet("/api/tasks?status=doing&limit=40").catch((e) => { if (e.status === 401) throw e; return { data: [] }; }),
  ]);
  state.overview = ov.data;
  state.consoleRev = ov.data && ov.data.console_rev ? ov.data.console_rev : 0;
  state.agents = agents.data || [];
  state.monitor = monitor.data;
  state.doing = doing.data || [];
  applyDoing(state.agents, state.doing);
  setHealth(state.monitor);
}

function mergeEvents(list) {
  (list || []).forEach((ev) => {
    if (!ev || !ev.event_id || state.seen.has(ev.event_id)) return;
    state.seen.add(ev.event_id);
    state.events.push(ev);
    if (ev.created_at) state.lastEventTs = Math.max(state.lastEventTs, ev.created_at);
  });
  state.events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || (a.event_id < b.event_id ? 1 : -1));
  if (state.events.length > 80) state.events.length = 80;
}

function stopPoll() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
}
function stopSlow() {
  if (state.slow) { clearInterval(state.slow); state.slow = null; }
}

function renderIfIdle() {
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  if ($("#drawer") && $("#drawer").dataset.open === "true") return;
  const page = parseRoute().page;
  if (page === "overview" || page === "agents" || page === "network") render();
}

async function refreshQuiet() {
  try {
    await refreshStatus();
    renderIfIdle();
  } catch (e) {
    setConn("error", "连接中断", e.message || "数据可能已过期");
  }
}

function connectStream() {
  stopPoll();
  if (state.es) { state.es.close(); state.es = null; }
  if (typeof EventSource !== "function") { startPoll(); return; }
  const since = state.lastEventTs || Math.floor(nowSec()) - 3600;
  let es;
  try {
    es = new EventSource(API + "/api/stream?since=" + since);
  } catch (e) {
    startPoll();
    return;
  }
  state.es = es;
  state.sseErrors = 0;
  es.addEventListener("event", (msg) => {
    state.sseErrors = 0;
    let ev;
    try { ev = JSON.parse(msg.data); } catch (e) { return; }
    if (ev && ev.event_id && state.seen.has(ev.event_id)) return;
    mergeEvents([ev]);
    const feed = $("#feed");
    if (feed && ev) {
      feed.insertAdjacentHTML("afterbegin", eventRow(ev));
      while (feed.children.length > 80) feed.removeChild(feed.lastChild);
    }
    if (!state.quietTimer) {
      state.quietTimer = setTimeout(() => { state.quietTimer = null; refreshQuiet(); }, 2500);
    }
  });
  es.onopen = () => setConn("push", "实时推送", "只开了一条 SSE");
  es.onerror = () => {
    state.sseErrors += 1;
    if (state.sseErrors < 2 && es.readyState !== EventSource.CLOSED) {
      setConn("error", "连接中断", "正在重连实时推送");
      return;
    }
    es.close();
    if (state.es === es) state.es = null;
    apiGet("/api/overview").then(() => {
      setConn("poll", "轮询模式", "实时推送不可用，已改为 6 秒轮询");
      startPoll();
    }).catch((e) => {
      setConn("error", "连接中断", e.message || "数据可能已过期，将继续重试");
      startPoll();
    });
  };
  stopSlow();
  state.slow = setInterval(refreshQuiet, 20000);
}

function startPoll() {
  if (state.es) { state.es.close(); state.es = null; }
  stopSlow();
  if (state.poll) return;
  setConn("poll", "轮询模式", "每 6 秒拉一次");
  const tick = async () => {
    await refreshQuiet();
    try {
      const body = await apiGet("/api/events?limit=40" + (state.lastEventTs ? "&since=" + state.lastEventTs : ""));
      mergeEvents(body.data);
      renderIfIdle();
    } catch (e) { /* 轮询失败时保留上次数据，下轮再试 */ }
  };
  state.poll = setInterval(tick, 6000);
}

function parseRoute() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
  const parts = raw.split("/").filter(Boolean);
  const page = NAV.some(([id]) => id === parts[0]) ? parts[0] : "overview";
  return { page, arg: parts[1] || "" };
}

function go(page) {
  if (location.hash !== "#/" + page) location.hash = "#/" + page;
  else render();
}

function renderNav() {
  const page = parseRoute().page;
  $("#nav").innerHTML = NAV.map(([id, label]) =>
    `<button type="button" data-page="${id}" aria-current="${page === id ? "page" : "false"}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>
      <span>${label}</span></button>`).join("");
  $("#nav").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
  $("#page-title").textContent = TITLES[page] || "总览";
}

function tally() {
  const s = { working: 0, idle: 0, offline: 0, unused: 0 };
  state.agents.filter((a) => a.status !== "disabled").forEach((a) => { s[statusOf(a)] += 1; });
  return s;
}

function eventRow(ev) {
  return `<div class="ops-event">
    <time>${esc(fmt(ev.created_at))}</time>
    <div><b>${esc(ev.source || "系统")}</b> · ${esc(ev.type || "")}
      <div class="ops-muted">${esc(ev.status || "")}${ev.event_id ? " · " + esc(ev.event_id) : ""}</div>
    </div></div>`;
}

function overviewHtml() {
  const t = tally();
  const ov = state.overview || {};
  const tasks = ov.tasks || {};
  const dead = tasks.dead || 0;
  const sys = (state.monitor && state.monitor.system) || {};
  const alerts = state.monitor && state.monitor.health && state.monitor.health.alerts;
  const mem = sys.mem_available_mb != null ? `可用内存 ${sys.mem_available_mb} MB` : "";
  const load = sys.loadavg ? `负载 ${sys.loadavg.join(" / ")}` : "";
  const hbs = ((state.monitor && state.monitor.heartbeats) || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return `
  <section class="ops-metrics" aria-label="系统摘要">
    <article class="sb-card ops-metric"><b>${t.working + t.idle}</b><span>在线 Agent</span><small>工作中 ${t.working} · 空闲 ${t.idle}</small></article>
    <article class="sb-card ops-metric"><b>${t.working}</b><span>正在工作</span><small>离线 ${t.offline} · 久未使用 ${t.unused}</small></article>
    <article class="sb-card ops-metric"><b>${ov.tasks_pending ?? "—"}</b><span>待办</span><small>执行中 ${ov.tasks_running ?? 0}</small></article>
    <article class="sb-card ops-metric"><b>${ov.pending_decisions ?? 0}</b><span>待批示</span><small>优先级 ≥ 1 的待办</small></article>
    <article class="sb-card ops-metric"><b>${ov.events_today ?? "—"}</b><span>今日事件</span><small>按服务器本地日历</small></article>
    <article class="sb-card ops-metric"><b>${dead ? "有" : "无"}</b><span>历史死信</span><small>${dead} 条，列表默认不展示</small></article>
  </section>
  <div class="ops-split">
    <section class="sb-card ops-panel">
      <h2>实时事件</h2>
      <div id="feed" class="ops-feed" aria-live="polite">
        ${state.events.length ? state.events.map(eventRow).join("") : '<p class="ops-muted">还没有事件。</p>'}
      </div>
    </section>
    <div>
      <section class="sb-card ops-panel" style="margin-bottom:16px">
        <h2>运行情况</h2>
        <dl class="ops-kv">
          <div><dt>巡检</dt><dd>${esc(alerts ? (alerts.length ? alerts.join("；") : "无告警") : "还没有健康巡检记录")}</dd></div>
          <div><dt>主机</dt><dd>${esc([load, mem].filter(Boolean).join(" · ") || "未读到")}</dd></div>
          <div><dt>失败 / 已完成</dt><dd>${tasks.failed || 0} / ${tasks.done || 0}</dd></div>
        </dl>
      </section>
      <section class="sb-card ops-panel">
        <h2>在场心跳</h2>
        <div class="ops-kv">
          ${hbs.length ? hbs.slice(0, 12).map((h) => `<div><dt>${esc(h.agent)}${h.agent_ref ? " → " + esc(h.agent_ref) : ""}</dt><dd>${esc(rel(h.ts))}${h.online ? " · 在线" : ""}</dd></div>`).join("") : '<p class="ops-muted">没有心跳记录。</p>'}
        </div>
      </section>
    </div>
  </div>`;
}

function agentCard(a) {
  const st = statusOf(a);
  const kindLabel = a.kind === "chief" ? "幕僚长" : "执行者";
  const role = roleOf(a);
  const sub = role === kindLabel ? kindLabel : role + " · " + kindLabel;
  const inst = (a.instances && a.instances.length)
    ? a.instances.map((i) => i.name).join("、")
    : (a.kind === "chief" ? "无在册实例" : "执行进程");
  const task = a.current_task
    ? `#${a.current_task.id} ${a.current_task.type || ""}${a.current_task.instruction ? " · " + a.current_task.instruction : ""}`
    : (a.current_task_id ? "任务 #" + a.current_task_id : "没有进行中的任务");
  const dec = a.pending_decisions ? ` · 待批示 ${a.pending_decisions}` : "";
  return `<button class="sb-card ops-card" type="button" data-agent="${esc(a.agent_id)}" data-status="${st}">
    <header><h3>${esc(a.agent_id)}</h3>${statusPill(st)}</header>
    <p>${esc(sub)}${a.verified === 0 ? " · 未验证" : ""}${dec}</p>
    <p>${esc(task)}</p>
    <footer><span>${esc(inst)}</span><span>${esc(fmt(seenAt(a)))}</span></footer>
  </button>`;
}

function agentsHtml() {
  const f = state.agentFilter;
  const list = state.agents.filter((a) => {
    if (f.kind !== "all" && a.kind !== f.kind) return false;
    if (f.status !== "all" && statusOf(a) !== f.status) return false;
    if (f.q) {
      const blob = `${a.agent_id} ${(a.instance_names || []).join(" ")} ${(a.instances || []).map((i) => i.name).join(" ")}`.toLowerCase();
      if (!blob.includes(f.q.toLowerCase())) return false;
    }
    return true;
  });
  const chip = (key, val, label) =>
    `<button type="button" data-chip="${key}:${val}" aria-pressed="${f[key] === val ? "true" : "false"}">${label}</button>`;
  return `
  <div class="ops-toolbar">
    <input id="agent-q" type="search" placeholder="搜索 Agent 或实例名" value="${esc(f.q)}" aria-label="搜索 Agent">
  </div>
  <div class="ops-chips" id="agent-chips">
    ${chip("status", "all", "全部状态")}
    ${chip("status", "working", "工作中")}
    ${chip("status", "idle", "空闲")}
    ${chip("status", "offline", "离线")}
    ${chip("status", "unused", "久未使用")}
    ${chip("kind", "all", "全部角色")}
    ${chip("kind", "chief", "幕僚长")}
    ${chip("kind", "worker", "执行者")}
  </div>
  <div class="ops-cards" style="margin-top:14px">
    ${list.length ? list.map(agentCard).join("") : '<p class="ops-muted">没有符合条件的 Agent。</p>'}
  </div>`;
}

function bindAgents() {
  const q = $("#agent-q");
  if (q) q.addEventListener("input", () => {
    state.agentFilter.q = q.value.trim();
    const pos = q.selectionStart;
    render();
    const again = $("#agent-q");
    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  });
  $("#agent-chips") && $("#agent-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-chip]");
    if (!b) return;
    const [k, v] = b.dataset.chip.split(":");
    state.agentFilter[k] = v;
    render();
  });
  $("#views").querySelectorAll("[data-agent]").forEach((b) =>
    b.addEventListener("click", () => { location.hash = "#/agents/" + encodeURIComponent(b.dataset.agent); }));
}

async function loadTasks() {
  const f = state.taskFilter;
  const host = $("#task-body");
  if (!host) return;
  host.innerHTML = '<p class="ops-muted">加载中…</p>';
  const legacy = !(state.consoleRev >= 1);
  let status = f.status;
  if (legacy && (status === "all" || !status)) status = "doing";
  const p = new URLSearchParams({ limit: "30", offset: String(f.offset || 0) });
  if (status && status !== "all") p.set("status", status);
  if (f.agent) p.set("agent", f.agent);
  if (f.q) p.set("q", f.q);
  try {
    const body = await apiGet("/api/tasks?" + p.toString());
    const rows = body.data || [];
    if (!status && rows.some((t) => t.status === "dead")) {
      state.consoleRev = 0;
      state.taskFilter.status = "doing";
      return loadTasks();
    }
    state.taskPage = body;
    const banner = legacy
      ? '<p class="ops-note">当前服务端还没标 console_rev，已按单个状态查询，避免把历史死信一次拉下来。默认看「执行中」。</p>'
      : (status === "dead"
        ? '<p class="ops-note">正在查看死信。这是历史风暴存量，只加载本页。</p>'
        : '<p class="ops-note">已隐藏死信。要看存量请把状态下拉改成「死信」。</p>');
    host.innerHTML = banner + taskTable(rows, body);
  } catch (e) {
    host.innerHTML = `<p class="ops-error">${esc(e.message)}</p>`;
  }
}

function taskTable(rows, body) {
  if (!rows.length) return '<p class="ops-muted">这一页没有任务。</p>';
  const total = body.total != null ? body.total : rows.length;
  const offset = body.offset || 0;
  const limit = body.limit || 30;
  return `<div class="ops-table-wrap"><table class="ops-table">
    <thead><tr><th>编号</th><th>状态</th><th>类型</th><th>Agent</th><th>摘要</th><th>进度</th><th>时间</th></tr></thead>
    <tbody>
      ${rows.map((t) => `<tr data-task="${t.id}">
        <td>#${t.id}</td><td>${taskPill(t.status)}</td><td>${esc(t.type)}</td>
        <td>${esc(t.lease_owner || "未领取")}</td>
        <td>${esc(t.summary || "")}</td>
        <td>${t.progress == null ? "—" : t.progress + "%"}</td>
        <td>${esc(fmt(t.done_at || t.claimed_at || t.created_at))}</td>
      </tr>`).join("")}
    </tbody></table></div>
    <div class="ops-pager">
      <button class="sb-button sb-button-secondary" type="button" id="task-prev" ${offset <= 0 ? "disabled" : ""}>上一页</button>
      <span class="ops-muted">${offset + 1}–${offset + rows.length} / ${total}</span>
      <button class="sb-button sb-button-secondary" type="button" id="task-next" ${offset + rows.length >= total ? "disabled" : ""}>下一页</button>
    </div>`;
}

function tasksHtml() {
  const f = state.taskFilter;
  const statuses = [["all", "全部（不含死信）"], ["doing", "执行中"], ["pending", "待办"], ["done", "已完成"], ["failed", "失败"], ["cancelled", "已取消"], ["dead", "死信"]];
  const agents = state.agents.map((a) => `<option value="${esc(a.agent_id)}" ${f.agent === a.agent_id ? "selected" : ""}>${esc(a.agent_id)}</option>`).join("");
  return `
  <div class="ops-toolbar">
    <input id="task-q" type="search" placeholder="搜索编号、类型、执行者、结果摘要" value="${esc(f.q)}" aria-label="搜索任务">
    <select id="task-status" aria-label="任务状态">
      ${statuses.map(([v, lab]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${lab}</option>`).join("")}
    </select>
    <select id="task-agent" aria-label="Agent"><option value="">全部 Agent</option>${agents}</select>
    <button class="sb-button sb-button-secondary" id="task-go" type="button">查询</button>
  </div>
  <div id="task-body"><p class="ops-muted">加载中…</p></div>`;
}

function bindTasks() {
  const apply = () => {
    state.taskFilter.q = $("#task-q").value.trim();
    state.taskFilter.status = $("#task-status").value;
    state.taskFilter.agent = $("#task-agent").value;
    state.taskFilter.offset = 0;
    loadTasks();
  };
  $("#task-go").addEventListener("click", apply);
  $("#task-q").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  $("#task-body").addEventListener("click", (e) => {
    const prev = e.target.closest("#task-prev");
    const next = e.target.closest("#task-next");
    const row = e.target.closest("[data-task]");
    if (prev) { state.taskFilter.offset = Math.max(0, (state.taskFilter.offset || 0) - 30); loadTasks(); }
    else if (next) { state.taskFilter.offset = (state.taskFilter.offset || 0) + 30; loadTasks(); }
    else if (row) location.hash = "#/tasks/" + row.dataset.task;
  });
  loadTasks();
}

function knowHtml() {
  const items = state.knowledge || [];
  const q = state.knowQ.trim().toLowerCase();
  const shown = q ? items.filter((it) => `${it.title} ${it.path} ${(it.tags || []).join(" ")} ${it.category}`.toLowerCase().includes(q)) : items;
  const groups = new Map();
  shown.forEach((it) => {
    const cat = it.category || "未分类";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  });
  const tree = [...groups.keys()].sort().map((cat) => `<details open>
    <summary>${esc(cat)} <span class="ops-muted">${groups.get(cat).length}</span></summary>
    ${groups.get(cat).map((it) => `<button type="button" data-doc="${esc(it.path)}" aria-current="${state.doc && state.doc.path === it.path ? "true" : "false"}">${esc(it.title || it.path)}</button>`).join("")}
  </details>`).join("");
  const doc = state.doc
    ? `<article class="ops-doc"><p class="ops-muted">${esc(state.doc.path)}${state.doc.degraded ? " · 全文接口未生效，下面是列表摘要" : ""}</p>
        <div class="ops-md"><h1>${esc(state.doc.title || "")}</h1>${state.doc.html || ""}</div></article>`
    : `<article class="ops-doc"><p class="ops-muted">从左侧点开一篇。${state.knowledge ? "共 " + items.length + " 篇。" : ""}</p></article>`;
  return `
  <div class="ops-toolbar">
    <input id="know-q" type="search" placeholder="搜索标题、路径、标签" value="${esc(state.knowQ)}" aria-label="搜索知识库">
  </div>
  <div class="ops-know">
    <aside class="sb-card ops-tree">${tree || '<p class="ops-muted">没有匹配的笔记。</p>'}</aside>
    ${doc}
  </div>`;
}

async function ensureKnowledge() {
  if (state.knowledge) return;
  const body = await apiGet("/api/knowledge?limit=500");
  state.knowledge = body.data || [];
}
async function openDoc(path) {
  const item = (state.knowledge || []).find((it) => it.path === path);
  try {
    const body = await apiGet("/api/knowledge/file?path=" + encodeURIComponent(path));
    state.doc = {
      path: body.data.path, title: body.data.title,
      html: renderMd(body.data.content || "") + (body.data.truncated ? '<p class="ops-note">正文过长，已截断。</p>' : ""),
    };
  } catch (e) {
    if (e.status === 404 && e.message === "not found") {
      state.doc = {
        path, title: item ? item.title : path, degraded: true,
        html: `<p>${esc(item && item.snippet ? item.snippet : "旧后端还没有全文接口。")}</p>`,
      };
    } else {
      state.doc = { path, title: path, html: `<p class="ops-error">${esc(e.message)}</p>` };
    }
  }
  if (parseRoute().page === "knowledge") render();
}

function bindKnowledge() {
  $("#know-q").addEventListener("input", () => { state.knowQ = $("#know-q").value; });
  $("#know-q").addEventListener("change", () => render());
  $("#views").querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDoc(b.dataset.doc)));
}

function networkHtml() {
  const rels = state.relations || [];
  const ids = [];
  rels.forEach((r) => { [r.source, r.target].forEach((id) => { if (id && !ids.includes(id)) ids.push(id); }); });
  const nodes = ids.map((id) => {
    const a = state.agents.find((x) => x.agent_id === id);
    return { id, kind: a ? a.kind : "worker", status: a ? statusOf(a) : "offline" };
  });
  const chiefs = nodes.filter((n) => n.kind === "chief");
  const workers = nodes.filter((n) => n.kind !== "chief");
  const gap = 176;
  const place = (list, y) => list.forEach((n, i) => { n.x = 24 + i * gap; n.y = y; });
  place(chiefs, 24);
  place(workers, 210);
  const width = Math.max(640, 48 + Math.max(chiefs.length, workers.length, 1) * gap);
  const height = 320;
  const center = (n) => ({ x: n.x + 74, y: n.y + 28 });
  const lines = rels.map((r) => {
    const a = nodes.find((n) => n.id === r.source);
    const b = nodes.find((n) => n.id === r.target);
    if (!a || !b) return "";
    const p = center(a), q = center(b);
    const cls = r.state === "active" ? "ops-edge active" : "ops-edge";
    const mid = (p.x + q.x) / 2 + (p.x === q.x ? 48 : 0);
    return `<path class="${cls}" d="M ${p.x} ${p.y} C ${mid} ${p.y}, ${mid} ${q.y}, ${q.x} ${q.y}"></path>`;
  }).join("");
  return `
  <p class="ops-note">线表示可以委派的通道。只有执行者当前有「执行中」任务时，那条历史通道才高亮流动。没有 doing 的线保持暗实线。</p>
  <div class="ops-split">
    <div style="overflow:auto">
    <div class="sb-card ops-net" style="width:${width}px;height:${height + 24}px">
      <svg width="${width}" height="${height}">${lines}</svg>
      ${nodes.map((n) => `<div class="sb-card ops-node" style="left:${n.x}px;top:${n.y}px" data-status="${n.status}">
        <b>${esc(n.id)}</b><span>${esc(STATUS_LABEL[n.status] || n.kind)}</span></div>`).join("")}
    </div>
    </div>
    <div class="ops-rel-list" id="rel-list">
      ${rels.length ? rels.map((r, i) => `<button class="sb-card" type="button" data-rel="${i}">
        <b>${esc(r.source)} → ${esc(r.target)}</b>
        <div class="ops-muted">${r.state === "active" ? "执行中，已高亮" : "闲置"} · ${r.evidence === "history" ? "有派发记录 " + r.task_count + " 次" : "默认路由，尚无派发"} · ${esc(r.last_at ? fmt(r.last_at) : "无时间")}</div>
      </button>`).join("") : '<p class="ops-muted">没有协作通道。</p>'}
    </div>
  </div>`;
}

async function ensureRelations() {
  const body = await apiGet("/api/relations");
  state.relations = body.data || [];
}

function renderMd(src) {
  const text = String(src || "").replace(/\r\n/g, "\n");
  const parts = text.split("```");
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const body = nl === -1 ? part : part.slice(nl + 1);
      return `<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`;
    }
    return mdBlocks(part);
  }).join("");
}
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const ok = /^(https?:\/\/|00-Inbox\/|10-Knowledge\/|20-Skills\/|30-Reviews\/|40-Agents\/|60-Outputs\/)/i.test(url);
    return ok ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return t;
}
function mdBlocks(src) {
  const lines = src.split("\n");
  let html = "", i = 0;
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(" "))}</p>`; para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flush(); i += 1; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i += 1; continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i += 1; }
      html += `<blockquote><p>${inline(buf.join(" "))}</p></blockquote>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1; }
      html += `<ul>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i += 1; }
      html += `<ol>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`;
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flush();
  return html;
}

function closeDrawer() {
  state.drawerSeq += 1;
  const d = $("#drawer");
  d.dataset.open = "false";
  d.innerHTML = "";
  $("#backdrop").hidden = true;
}
function showDrawer(html) {
  const d = $("#drawer");
  d.innerHTML = html;
  d.dataset.open = "true";
  $("#backdrop").hidden = false;
  const close = d.querySelector("[data-close]");
  if (close) close.addEventListener("click", () => {
    const route = parseRoute();
    if (route.arg) location.hash = "#/" + route.page;
    else closeDrawer();
  });
}

function traceHtml(t) {
  const paths = t.result_paths || [];
  const events = t.events || [];
  const notes = events.filter((e) => e.type === "task_progress");
  const payload = t.payload && typeof t.payload === "object"
    ? JSON.stringify(t.payload, null, 2)
    : (t.instruction || "");
  const prog = t.progress == null ? "" : `<div class="ops-prog" title="进度"><span style="width:${Math.max(0, Math.min(100, t.progress))}%"></span></div>
    <p class="ops-muted">${t.progress}% · 已过 ${t.elapsed_seconds ?? "—"} 秒 / 预计 ${t.estimate_seconds ?? "—"} 秒</p>`;
  return `<div class="ops-span">
    <header><b>#${t.id} · ${esc(t.type || "")}</b>${taskPill(t.status)}</header>
    <p class="ops-muted">${esc(t.lease_owner || "未领取")} · 创建 ${esc(fmt(t.created_at))}${t.claimed_at ? " · 领取 " + esc(fmt(t.claimed_at)) : ""}${t.done_at ? " · 完成 " + esc(fmt(t.done_at)) : ""}</p>
    ${prog}
    <p><b>指令原文</b></p>
    <pre class="ops-pre">${esc(t.instruction || "（payload 里没有 text / instruction）")}</pre>
    ${payload && payload !== (t.instruction || "") ? `<p><b>payload</b></p><pre class="ops-pre">${esc(payload)}</pre>` : ""}
    ${notes.length ? `<p><b>进度留痕</b></p><ul class="ops-tl">${notes.map((e) => {
      let note = "";
      try { note = (JSON.parse(e.payload || "{}") || {}).note || ""; } catch (err) { note = e.payload || ""; }
      return `<li><time>${esc(fmt(e.created_at))}</time><span>${esc(note || e.type)}</span></li>`;
    }).join("")}</ul>` : ""}
    ${events.length ? `<p><b>关联事件</b></p><ul class="ops-tl">${events.map((e) => `<li><time>${esc(fmt(e.created_at))}</time><span>${esc(e.source || "")} · ${esc(e.type || "")}</span></li>`).join("")}</ul>` : ""}
    ${t.result ? `<p><b>结果</b></p><pre class="ops-pre">${esc(String(t.result).slice(0, 1200))}</pre>` : ""}
    ${t.error ? `<p class="ops-error">${esc(t.error)}</p>` : ""}
    ${paths.length ? `<div class="ops-links">${paths.map((p) => `<button type="button" data-file="${esc(p)}">${esc(p)}</button>`).join("")}</div><div id="file-slot"></div>` : ""}
  </div>`;
}

function bindTrace(root) {
  root.querySelectorAll("[data-file]").forEach((b) => b.addEventListener("click", async () => {
    const slot = $("#file-slot") || root;
    slot.innerHTML = '<p class="ops-muted">正在读取结果文件…</p>';
    try {
      const body = await apiGet("/api/knowledge/file?path=" + encodeURIComponent(b.dataset.file));
      slot.innerHTML = `<div class="ops-md">${renderMd(body.data.content || "")}</div>`;
    } catch (e) {
      slot.innerHTML = e.status === 404 && e.message === "not found"
        ? '<p class="ops-note">全文接口尚未部署。线上若还是旧后端，结果文件暂时打不开，任务结果原文仍在上面。</p>'
        : `<p class="ops-error">${esc(e.message)}</p>`;
    }
  }));
  root.querySelectorAll("[data-expand]").forEach((b) => b.addEventListener("click", async () => {
    const box = b.parentElement.querySelector("[data-slot]");
    if (!box) return;
    box.innerHTML = '<p class="ops-muted">加载轨迹…</p>';
    try {
      const body = await apiGet("/api/tasks/" + b.dataset.expand);
      box.innerHTML = traceHtml(body.data);
      bindTrace(box);
    } catch (e) {
      box.innerHTML = `<p class="ops-note">这条轨迹暂时拉不到：${esc(e.message)}</p>`;
    }
  }));
}

async function openAgent(id) {
  const seq = ++state.drawerSeq;
  showDrawer(`<div class="ops-drawer-head"><div><h2>${esc(id)}</h2><p class="ops-muted">正在读取上下文…</p></div>
    <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>`);
  try {
    const body = await apiGet("/api/agents/" + encodeURIComponent(id));
    if (seq !== state.drawerSeq) return;
    paintAgent(body.data);
  } catch (e) {
    if (seq !== state.drawerSeq) return;
    const local = state.agents.find((a) => a.agent_id === id);
    showDrawer(`<div class="ops-drawer-head"><div><h2>${esc(id)}</h2></div>
      <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>
      <p class="ops-note">详情接口没有返回（${esc(e.message)}）。下面是列表里已有的字段。</p>
      ${local ? agentCard(local).replace("<button", "<div").replace("</button>", "</div>") : ""}`);
  }
}

function paintAgent(a) {
  const st = statusOf(a);
  const kindLabel = a.kind === "chief" ? "幕僚长" : "执行者";
  const role = roleOf(a);
  const sub = role === kindLabel ? kindLabel : role + " · " + kindLabel;
  const inst = (a.instances || []).map((i) =>
    `${esc(i.name)}${i.location ? " · " + esc(i.location) : ""} · 心跳 ${esc(i.heartbeat_at ? fmt(i.heartbeat_at) : "无")}${i.online ? " · 在线" : ""}`).join("<br>") || "没有挂到这个身份上的实例";
  const tasks = a.recent_tasks || [];
  const current = a.current_task;
  showDrawer(`
    <div class="ops-drawer-head">
      <div><h2>${esc(a.agent_id)}</h2><p class="ops-muted">${esc(sub)}</p></div>
      <div>${statusPill(st)} <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>
    </div>
    <dl class="ops-kv" style="margin:12px 0">
      <div><dt>最后心跳（北京时间）</dt><dd>${esc(fmt(seenAt(a)))} · ${esc(rel(seenAt(a)))}</dd></div>
      <div><dt>在场实例</dt><dd>${inst}</dd></div>
      <div><dt>待批示</dt><dd>${a.pending_decisions || 0}</dd></div>
    </dl>
    <h3>当前在做什么</h3>
    ${current ? traceHtml(current) : '<p class="ops-muted">名下没有执行中的任务。</p>'}
    <h3 style="margin-top:16px">最近轨迹</h3>
    ${tasks.length ? tasks.map((t) => `<div class="ops-span">
      <header><b>#${t.id} · ${esc(t.type || "")}</b>${taskPill(t.status)}</header>
      <p class="ops-muted">${esc(fmt(t.created_at))} · ${esc((t.instruction || t.summary || "").slice(0, 140) || "无指令摘要")}</p>
      <button class="ops-text-btn" type="button" data-expand="${t.id}">展开这条轨迹</button>
      <div data-slot></div>
    </div>`).join("") : '<p class="ops-muted">没有最近的非死信任务。</p>'}
  `);
  bindTrace($("#drawer"));
}

async function openTask(id) {
  const seq = ++state.drawerSeq;
  showDrawer(`<div class="ops-drawer-head"><div><h2>任务 #${esc(id)}</h2></div>
    <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>
    <p class="ops-muted">正在读取…</p>`);
  try {
    const body = await apiGet("/api/tasks/" + encodeURIComponent(id));
    if (seq !== state.drawerSeq) return;
    showDrawer(`<div class="ops-drawer-head"><div><h2>任务 #${esc(id)}</h2><p class="ops-muted">单条轨迹</p></div>
      <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>
      ${traceHtml(body.data)}`);
    bindTrace($("#drawer"));
  } catch (e) {
    if (seq !== state.drawerSeq) return;
    showDrawer(`<div class="ops-drawer-head"><h2>任务 #${esc(id)}</h2>
      <button class="sb-button sb-button-secondary" type="button" data-close>关闭</button></div>
      <p class="ops-error">${esc(e.message)}</p>`);
  }
}

function render() {
  const route = parseRoute();
  renderNav();
  const host = $("#views");
  host.innerHTML = "";
  if (route.page === "overview") host.innerHTML = overviewHtml();
  else if (route.page === "agents") { host.innerHTML = agentsHtml(); bindAgents(); }
  else if (route.page === "tasks") { host.innerHTML = tasksHtml(); bindTasks(); }
  else if (route.page === "knowledge") {
    const paintK = () => { host.innerHTML = knowHtml(); bindKnowledge(); };
    if (state.knowledge) paintK();
    else host.innerHTML = '<p class="ops-muted">正在读取知识库…</p>';
    if (!state.knowledge) ensureKnowledge().then(() => {
      if (parseRoute().page !== "knowledge") return;
      paintK();
    }).catch((e) => {
      host.innerHTML = `<p class="ops-error">${esc(e.message)}</p>`;
    });
  } else if (route.page === "network") {
    const paintN = () => { host.innerHTML = networkHtml(); };
    if (state.relations) paintN();
    else host.innerHTML = '<p class="ops-muted">正在读取协作通道…</p>';
    ensureRelations().then(() => {
      if (parseRoute().page !== "network") return;
      paintN();
    }).catch((e) => {
      host.innerHTML = `<p class="ops-error">${esc(e.message)}</p>`;
    });
  }
  if (route.page === "agents" && route.arg) openAgent(route.arg);
  else if (route.page === "tasks" && route.arg) openTask(route.arg);
  else if (!route.arg) closeDrawer();
}

async function boot() {
  try {
    await refreshStatus();
    const ev = await apiGet("/api/events?limit=40");
    state.events = [];
    state.seen = new Set();
    mergeEvents(ev.data);
    if (!location.hash) location.hash = "#/overview";
    render();
    connectStream();
  } catch (e) {
    setConn("error", "连接失败", e.message || "");
    const host = $("#views");
    if (host) host.innerHTML = `<p class="ops-error">进不去：${esc(e.message)}</p>`;
  }
}

function initTheme() {
  const saved = localStorage.getItem("sb-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  const btn = $("#theme-toggle");
  const sync = () => { btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "浅色" : "深色"; };
  sync();
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("sb-theme", next);
    sync();
  });
}

$("#backdrop").addEventListener("click", () => {
  const route = parseRoute();
  if (route.arg) location.hash = "#/" + route.page;
  else closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const route = parseRoute();
    if (route.arg) location.hash = "#/" + route.page;
    else closeDrawer();
  }
});
window.addEventListener("hashchange", () => { if (!$("#app").hidden) render(); });

initTheme();
boot();
