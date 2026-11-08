/* ==========================================================================
   Phase 3 原型 · 交互逻辑
   数据来源：data.js 静态演示数据（Phase 4 替换为 console_api + WebSocket）
   ========================================================================== */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NODE_W = 230, NODE_H = 76, GAP_X = 240, PAD_X = 60;
let WORLD_W = 0, WORLD_H = 440;

/* 按实际 Agent 数量自动排布（3 个画 3 个，30 个画 30 个），坐标不写死 */
function layoutAgents() {
  const chiefs = DEMO.agents.filter(a => a.kind === "chief");
  const workers = DEMO.agents.filter(a => a.kind === "worker");
  const cols = Math.max(chiefs.length, workers.length, 1);
  WORLD_W = PAD_X * 2 + cols * NODE_W + (cols - 1) * GAP_X;
  const place = (list, y) => {
    const total = list.length;
    if (!total) return;
    const startX = (WORLD_W - (total * NODE_W + (total - 1) * GAP_X)) / 2;
    list.forEach((a, i) => { a.x = startX + i * (NODE_W + GAP_X); a.y = y; });
  };
  place(chiefs, 40);
  place(workers, 340);
}

const STATUS_META = {
  idle:          { label: "空闲",   color: "var(--sb-text-tertiary)" },
  working:       { label: "执行中", color: "var(--sb-primary)" },
  collaborating: { label: "协作中", color: "var(--sb-collaborating)" },
  waiting:       { label: "等待中", color: "var(--sb-warning)" },
  completed:     { label: "已完成", color: "var(--sb-success)" },
  error:         { label: "异常",   color: "var(--sb-danger)" },
  offline:       { label: "离线",   color: "var(--sb-text-tertiary)" },
};

const NAV = [
  { id: "command",       label: "指挥中心", icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
  { id: "agents",        label: "Agent 管理", icon: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>' },
  { id: "tasks",         label: "任务中心", icon: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6l1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>' },
  { id: "collaboration", label: "协作中心", icon: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7"/>' },
  { id: "knowledge",     label: "知识图谱", icon: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6"/>' },
  { id: "memory",        label: "记忆中心", icon: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>' },
  { id: "monitor",       label: "系统监控", icon: '<path d="M3 12h4l2.5-6 4 12L16 12h5"/>' },
  { id: "settings",      label: "系统设置", icon: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>' },
];

/* 其余 7 页已在 Phase 5 接入真实数据（见文件末尾 pages 区块） */

const state = {
  view: "command",
  selected: null,            // 选中 Agent id
  panel: { target: null, pinned: false, history: [] },
  net: { scale: 1, tx: 0, ty: 0 },
  tl: { paused: false, filter: "all", pending: [] },
  sim: 0,
  filters: {
    agents: { status: "all", kind: "all", q: "" },
    tasks: { status: "all", agent: "", q: "", offset: 0 },
    collab: { state: "all" },
    knowledge: { q: "", category: "all" },
  },
  cache: { tasks: [], tasksTotal: 0, knowledge: [], knowledgeTotal: 0 },
};

/* ---------- 主题 ---------- */
function initTheme() {
  document.documentElement.setAttribute("data-theme",
    localStorage.getItem("sb-theme") || "light");
}
$("#theme-toggle").addEventListener("click", () => {
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "dark" ? "light" : "dark";
  el.setAttribute("data-theme", next);
  localStorage.setItem("sb-theme", next);
});

/* ---------- 导航与视图 ---------- */
function renderNav() {
  $("#nav").innerHTML = NAV.map(n => `
    <button class="pt-nav-item ${n.id === state.view ? "active" : ""}" data-view="${n.id}" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n.icon}</svg>
      <span>${n.label}</span>
    </button>`).join("");
  $$(".pt-nav-item").forEach(b =>
    b.addEventListener("click", () => switchView(b.dataset.view)));
}

function switchView(id) {
  state.view = id;
  if (id !== "command" && window.SB3D) SB3D.pause();
  $("#page-title").textContent = NAV.find(n => n.id === id).label;
  renderNav();
  const host = $("#views");
  host.innerHTML = "";
  if (id === "command") renderCommand(host);
  else renderPage(host, id);
}

/* ---------- 指挥中心 ---------- */
function renderCommand(host) {
  layoutAgents();
  const m = DEMO.metrics;
  host.innerHTML = `
  <section class="view" aria-label="指挥中心">
    <div class="pt-metrics">
      ${stat("指挥入口", m.chiefs, "按需调用")}
      ${stat("执行 Agent", m.workers, "常驻就绪")}
      ${stat("执行中任务", m.tasksRunning, m.tasksRunning ? "见任务中心" : "当前无执行")}
      ${stat("待处理", m.tasksPending, m.tasksPending ? "等待领取" : "无积压")}
      ${stat("今日事件", m.eventsToday, "实时流入")}
    </div>

    <div class="sb-card pt-net-card">
      <div class="pt-net-head">
        <h3>Agent 协作网络</h3>
        <div class="pt-net-tools">
          <button class="sb-button sb-button-secondary" data-net-fs type="button" title="只显示协作网络">⛶ 全屏</button>
          <button class="sb-button sb-button-secondary" data-zoom="out" type="button">−</button>
          <button class="sb-button sb-button-secondary" data-zoom="in" type="button">＋</button>
          <button class="sb-button sb-button-secondary" data-zoom="fit" type="button">适配</button>
          <button class="sb-button sb-button-secondary" data-zoom="reset" type="button">重置</button>
        </div>
      </div>
      <div class="pt-net" id="net" aria-label="Agent 协作网络画布">
        <canvas class="pt-net-3d" id="net3d" aria-hidden="true"></canvas>
        <div class="pt-net-canvas" id="net-canvas">
          <svg class="pt-net-svg" id="net-svg" width="${WORLD_W}" height="${WORLD_H}"></svg>
        </div>
        <span class="pt-net-hint">拖动平移 · 滚轮缩放 · 单击节点看详情 · Esc 关闭面板</span>
      </div>
    </div>

    <div class="sb-card pt-tl-card">
      <div class="pt-tl-head">
        <h3>实时事件时间轴</h3>
        <span class="pt-tl-live" id="tl-live">LIVE</span>
        <select id="tl-filter" aria-label="事件筛选">
          <option value="all">全部</option>
          <option value="task">任务</option>
          <option value="collaboration">协作</option>
          <option value="knowledge">知识</option>
          <option value="agent">Agent</option>
          <option value="system">系统</option>
        </select>
        <button class="sb-button sb-button-secondary" id="tl-pause" type="button">暂停滚动</button>
        ${window.SB && SB.data ? "" : '<button class="sb-button sb-button-ghost" id="tl-sim" type="button">模拟新事件（演示）</button>'}
        <button class="sb-button sb-button-ghost" type="button" disabled title="Phase 4 接入真实事件回放">历史回放（Phase 4）</button>
      </div>
      <button class="pt-tl-pending" id="tl-pending" type="button"></button>
      <div class="pt-tl" id="tl-list" aria-live="polite"></div>
    </div>
  </section>`;

  renderNetwork();
  renderTimeline();
  $("#tl-filter").addEventListener("change", e => { state.tl.filter = e.target.value; renderTimelineList(); });
  $("#tl-pause").addEventListener("click", togglePause);
  $("#tl-pending").addEventListener("click", flushPending);
  const simBtn = $("#tl-sim");
  if (simBtn) simBtn.addEventListener("click", simulateEvent);
}

const stat = (label, val, sub) =>
  `<div class="sb-card pt-stat"><small>${label}</small><b>${val}</b><em>${sub}</em></div>`;

/* ---------- 协作网络 ---------- */
function centerOf(a) { return { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 }; }

function renderNetwork() {
  const canvas = $("#net-canvas"), svg = $("#net-svg");

  // 连线（先画线，节点在上层）
  DEMO.edges.forEach(e => {
    const f = centerOf(DEMO.agents.find(a => a.id === e.from));
    const t = centerOf(DEMO.agents.find(a => a.id === e.to));
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "pt-edge");
    g.setAttribute("data-edge", e.id);
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", `协作关系：${DEMO.collabTypeMeta[e.type]}，${e.from} 到 ${e.to}`);
    const active = e.state === "active";
    g.innerHTML = `
      <title>${DEMO.collabTypeMeta[e.type]} · ${e.summary} · ${e.time}</title>
      <line x1="${f.x}" y1="${f.y}" x2="${t.x}" y2="${t.y}" stroke="transparent" stroke-width="14"/>
      <line class="pt-edge-line" x1="${f.x}" y1="${f.y}" x2="${t.x}" y2="${t.y}"
            stroke="var(--sb-primary)" stroke-width="${active ? 2.5 : 1.2}"
            opacity="${active ? 0.9 : 0.22}"/>
      ${active ? `<circle r="3.5" fill="var(--sb-primary)">
        <animateMotion dur="1.8s" repeatCount="indefinite" path="M ${f.x} ${f.y} L ${t.x} ${t.y}"/>
      </circle>` : ""}`;
    g.addEventListener("click", ev => { ev.stopPropagation(); openDetail({ type: "edge", id: e.id }); });
    g.addEventListener("keydown", ev => { if (ev.key === "Enter") openDetail({ type: "edge", id: e.id }); });
    svg.appendChild(g);
  });

  // 节点
  DEMO.agents.forEach(a => {
    const meta = STATUS_META[a.status];
    const wrap = document.createElement("div");
    wrap.className = "pt-node-wrap";
    wrap.style.left = a.x + "px";
    wrap.style.top = a.y + "px";
    wrap.dataset.agent = a.id;
    wrap.innerHTML = `
      <button class="agent-node ${state.selected === a.id ? "selected" : ""}" type="button"
              aria-label="${a.name}，${meta.label}">
        <span class="agent-node-indicator" style="background:${meta.color}"></span>
        <span class="agent-node-avatar">${a.name.trim()[0].toUpperCase()}</span>
        <span class="agent-node-info">
          <strong>${a.name}</strong>
          <span>${a.role} · ${a.kind === "chief" ? "指挥入口" : "执行者"}</span>
          <small>${a.currentTask ?? "当前无任务摘要"}</small>
        </span>
        <span class="sb-status" data-status="${a.status}">${meta.label}</span>
      </button>`;
    wrap.querySelector(".agent-node").addEventListener("click", ev => {
      ev.stopPropagation();
      selectAgent(a.id);
    });
    canvas.appendChild(wrap);
  });

  // 平移 / 缩放
  const net = $("#net");
  const is3D = !!(window.SB3D && SB3D.mount($("#net3d"), DEMO.agents, DEMO.edges,
    { onAgent: selectAgent, onMore: id => openDetail({ type: "agent", id }) }));
  if (is3D) {
    net.classList.add("is-3d");
    const hint = net.querySelector(".pt-net-hint");
    if (hint) hint.textContent = "工作中居中 · 空闲淡化 · 离线贴边 ｜ 悬停看概况 · 点击进入场景 · 拖动旋转";
  } else if (window.SB3D) {
    const hint = net.querySelector(".pt-net-hint");
    if (hint) hint.textContent = "当前浏览器未启用 WebGL，已降级为 2D 视图 · 拖动平移 · 滚轮缩放";
  }
  const netCard = net.closest(".pt-net-card");
  const fsBtn = netCard && netCard.querySelector("[data-net-fs]");
  if (fsBtn && !fsBtn.dataset.bound) {
    fsBtn.dataset.bound = "1";
    fsBtn.addEventListener("click", () => {
      const on = netCard.classList.toggle("net-fullscreen");
      document.body.classList.toggle("net-fs", on);
      fsBtn.textContent = on ? "退出全屏" : "⛶ 全屏";
      setTimeout(() => window.SB3D && SB3D.resize && SB3D.resize(), 60);
    });
  }
  if (!is3D && !state.net.inited) { fitNet(); state.net.inited = true; }   // 定时刷新时保留用户视角
  else if (!is3D) applyNet();
  net.addEventListener("wheel", e => {
    if (net.classList.contains("is-3d")) return;
    e.preventDefault();
    const r = net.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    zoomAt(mx, my, e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });
  let drag = null;
  net.addEventListener("pointerdown", e => {
    if (net.classList.contains("is-3d")) return;
    // 只在画布空白处启动平移；节点/连线上按下则不捕获指针，保证点击事件正常触发
    if (e.target.closest(".agent-node") || e.target.closest(".pt-edge")) return;
    drag = { x: e.clientX, y: e.clientY, tx: state.net.tx, ty: state.net.ty, moved: false };
    net.setPointerCapture(e.pointerId);
    net.classList.add("panning");
  });
  net.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    state.net.tx = drag.tx + dx;
    state.net.ty = drag.ty + dy;
    applyNet();
  });
  net.addEventListener("pointerup", () => {
    net.classList.remove("panning");
    if (drag && !drag.moved && !state.panel.pinned) closeDetail();
    drag = null;
  });
  $$(".pt-net-tools [data-zoom]").forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.zoom;
    if (net.classList.contains("is-3d")) {
      if (act === "fit" || act === "reset") SB3D.reset();
      else SB3D.zoom(act === "in" ? 0.85 : 1.18);
      return;
    }
    if (act === "fit" || act === "reset") fitNet(act === "reset");
    else {
      const r = net.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, act === "in" ? 1.2 : 1 / 1.2);
    }
  }));
}

function applyNet() {
  $("#net-canvas").style.transform =
    `translate(${state.net.tx}px, ${state.net.ty}px) scale(${state.net.scale})`;
}
function zoomAt(mx, my, factor) {
  const n = state.net;
  const ns = Math.min(1.8, Math.max(0.4, n.scale * factor));
  n.tx = mx - (mx - n.tx) * (ns / n.scale);
  n.ty = my - (my - n.ty) * (ns / n.scale);
  n.scale = ns;
  applyNet();
}
function fitNet(reset) {
  const net = $("#net");
  const r = net.getBoundingClientRect();
  const s = reset ? 1 : Math.min(r.width / WORLD_W, r.height / WORLD_H, 1);
  state.net.scale = s;
  state.net.tx = (r.width - WORLD_W * s) / 2;
  state.net.ty = Math.max(12, (r.height - WORLD_H * s) / 2);
  applyNet();
}

function selectAgent(id) {
  state.selected = id;
  if (window.SB3D) SB3D.select(id);
  // 高亮关联连线，淡化无关元素
  const related = DEMO.edges.filter(e => e.from === id || e.to === id).map(e => e.id);
  $$(".pt-edge").forEach(g =>
    g.classList.toggle("dim", related.length > 0 && !related.includes(g.dataset.edge)));
  const neighborIds = new Set([id]);
  DEMO.edges.forEach(e => {
    if (e.from === id) neighborIds.add(e.to);
    if (e.to === id) neighborIds.add(e.from);
  });
  $$(".pt-node-wrap").forEach(w =>
    w.classList.toggle("dim", !neighborIds.has(w.dataset.agent)));
  $$(".pt-node-wrap .agent-node").forEach(n =>
    n.classList.toggle("selected", n.closest(".pt-node-wrap").dataset.agent === id));
  openDetail({ type: "agent", id });
}

/* ---------- 事件时间轴 ---------- */
function tlMatch(e) {
  if (state.tl.filter === "all") return true;
  return e.type.startsWith(state.tl.filter);
}
function renderTimeline() { renderTimelineList(); }
function renderTimelineList() {
  const list = $("#tl-list");
  if (!list) return;
  list.innerHTML = DEMO.events.filter(tlMatch).map(e => {
    const meta = DEMO.eventTypeMeta[e.type] || { label: e.type, color: "var(--sb-text-tertiary)" };
    return `
    <button class="pt-tl-item" data-event="${e.id}" type="button">
      <span class="pt-tl-dot" style="background:${meta.color}"></span>
      <span class="pt-tl-time">${e.time}</span>
      <span class="pt-tl-text">${e.text}</span>
      <span class="pt-tl-type">${meta.label}</span>
    </button>`;
  }).join("");
  $$(".pt-tl-item", list).forEach(b =>
    b.addEventListener("click", () => openDetail({ type: "event", id: b.dataset.event })));
}
function togglePause() {
  state.tl.paused = !state.tl.paused;
  $("#tl-pause").textContent = state.tl.paused ? "继续滚动" : "暂停滚动";
  $("#tl-live").style.visibility = state.tl.paused ? "hidden" : "visible";
  if (!state.tl.paused) flushPending();
}
function simulateEvent() {
  const tpl = DEMO.livePool[state.sim++ % DEMO.livePool.length];
  const ev = { id: `evt_sim_${state.sim}`, type: tpl.type, source: tpl.source,
    taskId: tpl.taskId, text: tpl.text,
    time: new Date().toTimeString().slice(0, 8) };
  if (state.tl.paused) {
    state.tl.pending.push(ev);
    const bar = $("#tl-pending");
    bar.textContent = `暂停中：${state.tl.pending.length} 条新事件待查看（点击展开）`;
    bar.classList.add("show");
  } else {
    DEMO.events.unshift(ev);
    renderTimelineList();
  }
}
function flushPending() {
  if (!state.tl.pending.length) return;
  DEMO.events.unshift(...state.tl.pending.reverse());
  state.tl.pending = [];
  $("#tl-pending").classList.remove("show");
  renderTimelineList();
}

/* ---------- 详情面板 ---------- */
function openDetail(target, pushHistory = true) {
  const p = state.panel;
  if (pushHistory && p.target) p.history.push(p.target);
  p.target = target;
  renderDetail();
  $("#detail").dataset.open = "true";
}
function closeDetail() {
  state.panel.target = null;
  state.panel.history = [];
  $("#detail").dataset.open = "false";
}
function goBack() {
  const prev = state.panel.history.pop();
  if (prev) openDetail(prev, false);
}

function detailRow(k, v) {
  return `<div class="row"><span>${k}</span><span>${v}</span></div>`;
}

function renderDetail() {
  const { target, pinned, history } = state.panel;
  const host = $("#detail");
  if (!target) { host.innerHTML = ""; return; }
  let title = "", kind = "", body = "";

  if (target.type === "agent") {
    const a = DEMO.agents.find(x => x.id === target.id);
    const meta = STATUS_META[a.status];
    const edges = DEMO.edges.filter(e => e.from === a.id || e.to === a.id);
    const events = DEMO.events.filter(e =>
      (e.rawSource && e.rawSource === a.id) || e.source === a.name).slice(0, 5);
    kind = "Agent 详情"; title = a.name;
    body = `
      <div class="pt-dp-sec"><h3>基本信息</h3><div class="pt-dl">
        ${detailRow("Agent ID", a.id)}
        ${detailRow("角色", a.role)}
        ${detailRow("类型", a.kind === "chief" ? "指挥入口（非常驻）" : "执行者（常驻线程）")}
        ${detailRow("状态", `<span class="sb-status" data-status="${a.status}">${meta.label}</span>`)}
        ${detailRow("最近活动", a.lastActive)}
      </div></div>
      <div class="pt-dp-sec"><h3>当前任务</h3><div class="pt-dl">
        ${detailRow("任务摘要", a.currentTask ?? "暂无任务")}
      </div></div>
      <div class="pt-dp-sec"><h3>协作对象（${edges.length}）</h3>
        ${edges.map(e => {
          const other = e.from === a.id ? e.to : e.from;
          return `<button class="pt-dp-link" data-goto-agent="${other}" type="button">
            ${DEMO.collabTypeMeta[e.type]} · ${other}
            <small>${e.summary} · ${e.time}</small></button>`;
        }).join("") || '<small class="sb-text-tertiary">暂无协作记录</small>'}
      </div>
      <div class="pt-dp-sec"><h3>最近活动</h3>
        ${events.map(e => `<button class="pt-dp-link" data-goto-event="${e.id}" type="button">
          ${e.text}<small>${e.time}</small></button>`).join("") || '<small class="sb-text-tertiary">暂无活动</small>'}
      </div>
      <div class="pt-dp-sec"><h3>健康与权限</h3><div class="pt-dl">
        ${detailRow("最近心跳", a.lastActive)}
        ${detailRow("在线判定", meta.label)}
        ${detailRow("能力", (a.capabilities || []).join(" / ") || "未登记")}
        ${detailRow("任务类型", (a.task_types || []).join(" / ") || "未登记")}
        ${detailRow("权限", a.kind === "chief" ? "七接口指挥权" : "知识库/产出写入")}
      </div></div>`;
  }

  if (target.type === "edge") {
    const e = DEMO.edges.find(x => x.id === target.id);
    kind = "协作详情"; title = `${e.from} → ${e.to}`;
    body = `
      <div class="pt-dp-sec"><h3>协作关系</h3><div class="pt-dl">
        ${detailRow("类型", DEMO.collabTypeMeta[e.type])}
        ${detailRow("发起方", e.from)}
        ${detailRow("接收方", e.to)}
        ${detailRow("关联任务", e.taskId)}
        ${detailRow("发生时间", e.time)}
        ${detailRow("当前状态", e.state === "active" ? "协作进行中" : "近期协作")}
        ${detailRow("摘要", e.summary)}
      </div></div>
      <div class="pt-dp-sec"><h3>关联对象</h3>
        <button class="pt-dp-link" data-goto-agent="${e.from}" type="button">发起方：${e.from}</button>
        <button class="pt-dp-link" data-goto-agent="${e.to}" type="button">接收方：${e.to}</button>
      </div>`;
  }

  if (target.type === "event") {
    const e = DEMO.events.find(x => x.id === target.id);
    const meta = DEMO.eventTypeMeta[e.type] || { label: e.type };
    kind = "事件详情"; title = meta.label;
    body = `
      <div class="pt-dp-sec"><h3>事件</h3><div class="pt-dl">
        ${detailRow("事件 ID", e.id)}
        ${detailRow("类型", `${meta.label}（${e.type}）`)}
        ${detailRow("时间", e.time)}
        ${detailRow("来源", e.source)}
        ${detailRow("关联任务", e.taskId ?? "无")}
        ${detailRow("内容", e.text)}
      </div></div>`;
    const srcAgents = DEMO.agents.filter(a => e.source.includes(a.id));
    if (srcAgents.length) {
      body += `<div class="pt-dp-sec"><h3>关联 Agent</h3>
        ${srcAgents.map(a => `<button class="pt-dp-link" data-goto-agent="${a.id}" type="button">${a.name}<small>${a.role}</small></button>`).join("")}
      </div>`;
    }
  }

  host.innerHTML = `
    <div class="pt-dp-head">
      <div><small>${kind}</small><h3>${title}</h3></div>
      <div class="pt-dp-actions">
        ${history.length ? '<button class="pt-icon-btn" data-act="back" type="button" aria-label="返回上一个">←</button>' : ""}
        <button class="pt-icon-btn ${pinned ? "pinned" : ""}" data-act="pin" type="button" aria-label="固定面板" title="固定">⌘</button>
        <button class="pt-icon-btn" data-act="close" type="button" aria-label="关闭面板">✕</button>
      </div>
    </div>
    <div class="pt-dp-body">${body}</div>`;

  $$("[data-act]", host).forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "close") closeDetail();
    if (act === "pin") { state.panel.pinned = !state.panel.pinned; renderDetail(); }
    if (act === "back") goBack();
  }));
  $$("[data-goto-agent]", host).forEach(b => b.addEventListener("click", () => {
    if (state.view !== "command") switchView("command");
    selectAgent(b.dataset.gotoAgent);
  }));
  $$("[data-goto-event]", host).forEach(b => b.addEventListener("click", () =>
    openDetail({ type: "event", id: b.dataset.gotoEvent })));
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    const fs = document.querySelector(".pt-net-card.net-fullscreen");
    if (fs) {
      fs.classList.remove("net-fullscreen");
      document.body.classList.remove("net-fs");
      const b = fs.querySelector("[data-net-fs]");
      if (b) b.textContent = "⛶ 全屏";
      if (window.SB3D) SB3D.resize();
    }
  }
  if (e.key === "Escape" && state.panel.target) closeDetail();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#global-search").focus();
  }
});

/* ---------- 全局搜索（演示：过滤节点与时间轴文本） ---------- */
$("#global-search").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  if (state.view !== "command") switchView("command");
  $$(".pt-node-wrap").forEach(w => {
    const a = DEMO.agents.find(x => x.id === w.dataset.agent);
    const hit = !q || `${a.name} ${a.role} ${a.id}`.toLowerCase().includes(q);
    w.classList.toggle("dim", !hit);
  });
  $$(".pt-tl-item").forEach(i =>
    i.style.display = !q || i.textContent.toLowerCase().includes(q) ? "" : "none");
});

/* ==========================================================================
   Phase 5 · 七个业务页面（数据全部来自 console_api 真实接口）
   纪律：没有可靠数据就显示「暂无数据」，不做二次推算、不编造。
   ========================================================================== */
const PAGE_STATUS = {
  pending:   { label: "待领取", cls: "waiting" },
  doing:     { label: "执行中", cls: "working" },
  done:      { label: "已完成", cls: "completed" },
  failed:    { label: "失败",   cls: "failed" },
  dead:      { label: "死信",   cls: "failed" },
  cancelled: { label: "已取消", cls: "cancelled" },
};
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTs = ts => ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
const relTime = ts => {
  if (!ts) return "从未";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
};
const badge = (cls, label) => `<span class="sb-status" data-status="${cls}">${label}</span>`;

function renderPage(host, id) {
  const scroller = $(".sb-content");
  const keep = scroller ? scroller.scrollTop : 0;
  if (!(window.SB && SB.data)) {
    if (id === "settings") renderSettingsPage(host);
    else renderNoData(host, id);
  } else {
    const map = {
      agents: renderAgentsPage, tasks: renderTasksPage, collaboration: renderCollabPage,
      knowledge: renderKnowledgePage, memory: renderMemoryPage, monitor: renderMonitorPage,
      settings: renderSettingsPage,
    };
    (map[id] || renderNoData)(host, id);
  }
  if (scroller) scroller.scrollTop = keep;
}

function renderNoData(host, id) {
  const label = (NAV.find(n => n.id === id) || {}).label || "该页面";
  host.innerHTML = `<section class="view">
    <div class="sb-card pt-empty">
      <h3>暂无数据</h3>
      <p class="sb-text-secondary">${label}只展示后端真实数据。当前未接入只读口令，或后端尚未产生该类数据。</p>
      <button class="sb-button sb-button-primary" id="empty-connect" type="button">接入真实数据</button>
    </div>
  </section>`;
  const btn = $("#empty-connect");
  if (btn) btn.addEventListener("click", () => window.SB && SB.connect && SB.connect());
}

/* ---------- 通用详情面板（真实数据版本） ---------- */
function openPanel(kind, title, body) {
  const host = $("#detail");
  const p = state.panel;
  host.innerHTML = `
    <div class="pt-dp-head">
      <div><small>${esc(kind)}</small><h3>${esc(title)}</h3></div>
      <div class="pt-dp-actions">
        ${p.history.length ? '<button class="pt-icon-btn" data-act="back" type="button" aria-label="返回">←</button>' : ""}
        <button class="pt-icon-btn ${p.pinned ? "pinned" : ""}" data-act="pin" type="button" aria-label="固定">⌘</button>
        <button class="pt-icon-btn" data-act="close" type="button" aria-label="关闭">✕</button>
      </div>
    </div>
    <div class="pt-dp-body" id="panel-body">${body}</div>`;
  host.dataset.open = "true";
  $$("[data-act]", host).forEach(b => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "close") closeDetail();
    if (act === "pin") { p.pinned = !p.pinned; openPanel(kind, title, body); }
    if (act === "back") goBack();
  }));
  return $("#panel-body");
}

/* ---------- 1. Agent 管理 ---------- */
function renderAgentsPage(host) {
  const f = state.filters.agents;
  const agents = DEMO.agents;
  host.innerHTML = `<section class="view" aria-label="Agent 管理">
    <div class="pt-toolbar">
      <input id="ag-q" class="pt-input" type="search" placeholder="搜索名称 / ID / 角色" value="${esc(f.q)}">
      <select id="ag-status" class="pt-select">
        ${[["all", "全部状态"], ["idle", "空闲"], ["working", "执行中"], ["offline", "离线"]]
          .map(([v, t]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <select id="ag-kind" class="pt-select">
        ${[["all", "全部类型"], ["chief", "指挥入口"], ["worker", "执行者"]]
          .map(([v, t]) => `<option value="${v}" ${f.kind === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <span class="pt-count" id="ag-count"></span>
    </div>
    <div class="pt-agent-grid" id="ag-grid"></div>
  </section>`;

  const grid = $("#ag-grid");
  grid.innerHTML = agents.map(a => {
    const meta = STATUS_META[a.status] || STATUS_META.idle;
    return `<button class="sb-card pt-agent-card" data-id="${esc(a.id)}"
        data-status="${a.status}" data-kind="${a.kind}"
        data-text="${esc(`${a.name} ${a.id} ${a.role}`.toLowerCase())}" type="button">
      <div class="pt-agent-head">
        <span class="agent-node-avatar">${esc((a.name || "?").trim()[0].toUpperCase())}</span>
        <div class="pt-agent-id"><strong>${esc(a.name)}</strong><small>${esc(a.role)}</small></div>
        ${badge(a.status, meta.label)}
      </div>
      <p class="pt-agent-task">${esc(a.currentTask || "当前无任务")}</p>
      <div class="pt-agent-foot">
        <span class="pt-tag">${a.kind === "chief" ? "指挥入口" : "执行者"}</span>
        <span class="sb-text-tertiary">最近活动：${esc(a.lastActive)}</span>
      </div>
    </button>`;
  }).join("") || '<div class="pt-empty-inline">暂无数据</div>';

  const applyFilter = () => {
    let n = 0;
    $$(".pt-agent-card", grid).forEach(c => {
      const hit = (f.status === "all" || c.dataset.status === f.status)
        && (f.kind === "all" || c.dataset.kind === f.kind)
        && (!f.q || c.dataset.text.includes(f.q));
      c.hidden = !hit;
      if (hit) n++;
    });
    $("#ag-count").textContent = `显示 ${n} / ${agents.length}`;
  };
  $("#ag-q").addEventListener("input", e => { f.q = e.target.value.trim().toLowerCase(); applyFilter(); });
  $("#ag-status").addEventListener("change", e => { f.status = e.target.value; applyFilter(); });
  $("#ag-kind").addEventListener("change", e => { f.kind = e.target.value; applyFilter(); });
  applyFilter();
  $$(".pt-agent-card", grid).forEach(c =>
    c.addEventListener("click", () => selectAgent(c.dataset.id)));
}

/* ---------- 2. 任务中心 ---------- */
function renderTasksPage(host) {
  const f = state.filters.tasks;
  host.innerHTML = `<section class="view" aria-label="任务中心">
    <div class="pt-toolbar">
      <input id="tk-q" class="pt-input" type="search" placeholder="搜索任务 ID / 类型 / 结果" value="${esc(f.q)}">
      <select id="tk-status" class="pt-select">
        ${[["all", "全部状态"], ["doing", "执行中"], ["pending", "待领取"], ["done", "已完成"],
           ["failed", "失败"], ["dead", "死信"], ["cancelled", "已取消"]]
          .map(([v, t]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <select id="tk-agent" class="pt-select">
        <option value="">全部 Agent</option>
        ${DEMO.agents.map(a => `<option value="${esc(a.id)}" ${f.agent === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
      </select>
      <button class="sb-button sb-button-secondary" id="tk-refresh" type="button">刷新</button>
      <span class="pt-count" id="tk-count"></span>
    </div>
    <div class="pt-list" id="tk-list"><div class="pt-loading">加载中…</div></div>
    <div class="pt-more"><button class="sb-button sb-button-secondary" id="tk-more" type="button" hidden>加载更多</button></div>
  </section>`;

  const reload = reset => loadTasks(reset);
  $("#tk-q").addEventListener("change", e => { f.q = e.target.value.trim(); reload(true); });
  $("#tk-status").addEventListener("change", e => { f.status = e.target.value; reload(true); });
  $("#tk-agent").addEventListener("change", e => { f.agent = e.target.value; reload(true); });
  $("#tk-refresh").addEventListener("click", () => reload(true));
  $("#tk-more").addEventListener("click", () => { f.offset += 50; reload(false); });
  reload(true);
}

async function loadTasks(reset) {
  const f = state.filters.tasks;
  const list = $("#tk-list");
  if (!list) return;
  if (reset) { f.offset = 0; state.cache.tasks = []; list.innerHTML = '<div class="pt-loading">加载中…</div>'; }
  const p = new URLSearchParams({ limit: "50", offset: String(f.offset) });
  if (f.status !== "all") p.set("status", f.status);
  if (f.agent) p.set("agent", f.agent);
  if (f.q) p.set("q", f.q);
  try {
    const body = await SB.api("/api/tasks?" + p.toString());
    state.cache.tasks = reset ? body.data : state.cache.tasks.concat(body.data);
    state.cache.tasksTotal = body.total;
    renderTaskList();
  } catch (e) {
    list.innerHTML = `<div class="pt-empty-inline">加载失败：${esc(e.message)}</div>`;
  }
}

function renderTaskList() {
  const list = $("#tk-list");
  if (!list) return;
  const rows = state.cache.tasks || [];
  if (!rows.length) {
    list.innerHTML = '<div class="pt-empty-inline">暂无数据</div>';
    $("#tk-count").textContent = "";
    $("#tk-more").hidden = true;
    return;
  }
  list.innerHTML = rows.map(t => {
    const st = PAGE_STATUS[t.status] || { label: t.status, cls: "idle" };
    const prog = t.progress == null ? "" : `
      <div class="pt-prog"><span style="width:${Math.max(0, Math.min(100, t.progress))}%"></span></div>
      <small class="sb-text-tertiary">${t.progress}% · 已过 ${t.elapsed_seconds}s / 预计 ${t.estimate_seconds}s（样本 ${t.estimate_samples}）</small>`;
    return `<button class="sb-card pt-task-card" data-id="${t.id}" type="button">
      <div class="pt-task-head">
        <strong>#${t.id} · ${esc(t.type)}</strong>
        ${badge(st.cls, st.label)}
      </div>
      <p class="pt-task-sum">${esc(t.summary || "暂无摘要")}</p>
      ${prog}
      <div class="pt-task-foot">
        <span>${esc(t.lease_owner || "未分配")}</span>
        <span>优先级 P${t.priority ?? "—"}</span>
        <span>${fmtTs(t.created_at)}</span>
      </div>
    </button>`;
  }).join("");
  $("#tk-count").textContent = `共 ${state.cache.tasksTotal} 条 · 已加载 ${rows.length}`;
  $("#tk-more").hidden = rows.length >= state.cache.tasksTotal;
  $$(".pt-task-card", list).forEach(b =>
    b.addEventListener("click", () => openTaskDetail(b.dataset.id)));
}

async function openTaskDetail(id) {
  const body = openPanel("任务详情", `#${id}`, '<div class="pt-loading">加载中…</div>');
  try {
    const b = await SB.api("/api/tasks/" + id);
    const t = b.data;
    const st = PAGE_STATUS[t.status] || { label: t.status, cls: "idle" };
    const evs = (t.events || []).map(e => `<button class="pt-dp-link" type="button">
        ${esc(e.type)} <small>${esc(e.source)} · ${fmtTs(e.created_at)}</small></button>`).join("")
      || '<small class="sb-text-tertiary">暂无关联事件</small>';
    body.innerHTML = `
      <div class="pt-dp-sec"><h3>任务信息</h3><div class="pt-dl">
        ${detailRow("任务 ID", "#" + t.id)}
        ${detailRow("类型", esc(t.type))}
        ${detailRow("状态", badge(st.cls, st.label))}
        ${detailRow("执行 Agent", esc(t.lease_owner || "未分配"))}
        ${detailRow("优先级", "P" + (t.priority ?? "—"))}
        ${detailRow("重试次数", t.retry_count ?? 0)}
        ${detailRow("创建时间", fmtTs(t.created_at))}
        ${detailRow("领取时间", fmtTs(t.claimed_at))}
        ${detailRow("完成时间", fmtTs(t.done_at))}
      </div></div>
      <div class="pt-dp-sec"><h3>进度（自学习估算）</h3><div class="pt-dl">
        ${detailRow("进度", t.progress == null ? "—" : t.progress + "%")}
        ${detailRow("已过", t.elapsed_seconds == null ? "—" : t.elapsed_seconds + " 秒")}
        ${detailRow("预计", t.estimate_seconds == null ? "—" : t.estimate_seconds + " 秒")}
        ${detailRow("样本数", t.estimate_samples ?? "—")}
      </div></div>
      <div class="pt-dp-sec"><h3>结果 / 错误</h3>
        <p class="pt-pre">${esc(t.result || t.error || "暂无数据")}</p></div>
      <div class="pt-dp-sec"><h3>Payload</h3>
        <pre class="pt-pre">${esc(JSON.stringify(t.payload || {}, null, 2))}</pre></div>
      <div class="pt-dp-sec"><h3>关联事件（${(t.events || []).length}）</h3>${evs}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="pt-empty-inline">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------- 3. 协作中心 ---------- */
function renderCollabPage(host) {
  const f = state.filters.collab;
  const rels = DEMO.edges || [];
  const evs = (DEMO.events || []).filter(e =>
    ["task_delegated", "task_linked", "chief_cmd", "chief_result", "api_call", "task_progress"].includes(e.rawType));
  host.innerHTML = `<section class="view" aria-label="协作中心">
    <div class="pt-toolbar">
      <select id="cl-state" class="pt-select">
        ${[["all", "全部通道"], ["active", "进行中"], ["idle", "空闲"]]
          .map(([v, t]) => `<option value="${v}" ${f.state === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <span class="pt-count" id="cl-count"></span>
      <span class="sb-text-tertiary" style="margin-left:auto">连线只表示「可委派通道」；进行中才发光</span>
    </div>
    <div class="pt-cols">
      <div class="sb-card pt-panel">
        <h3 class="pt-panel-title">协作通道</h3>
        <div id="cl-list"></div>
      </div>
      <div class="sb-card pt-panel">
        <h3 class="pt-panel-title">协作相关事件</h3>
        <div id="cl-events"></div>
      </div>
    </div>
  </section>`;

  const list = $("#cl-list");
  list.innerHTML = rels.map(r => {
    const active = r.state === "active";
    return `<button class="pt-rel-row" data-rel="${esc(r.id)}" type="button">
      <span class="pt-rel-dot" data-active="${active ? 1 : 0}"></span>
      <span class="pt-rel-main">
        <strong>${esc(r.from)} → ${esc(r.to)}</strong>
        <small>${esc(r.summary)} · ${esc(r.time)}</small>
      </span>
      ${active ? badge("working", "进行中") : badge("idle", "空闲")}
    </button>`;
  }).join("") || '<div class="pt-empty-inline">暂无数据</div>';

  $("#cl-events").innerHTML = evs.map(e => {
    const meta = DEMO.eventTypeMeta[e.type] || { label: e.type, color: "var(--sb-text-tertiary)" };
    return `<button class="pt-tl-item" data-event="${esc(e.id)}" type="button">
      <span class="pt-tl-dot" style="background:${meta.color}"></span>
      <span class="pt-tl-time">${esc(e.time)}</span>
      <span class="pt-tl-text">${esc(e.text)}</span>
      <span class="pt-tl-type">${esc(meta.label)}</span>
    </button>`;
  }).join("") || '<div class="pt-empty-inline">暂无数据</div>';

  const apply = () => {
    let n = 0;
    $$(".pt-rel-row", list).forEach(row => {
      const rel = rels.find(r => r.id === row.dataset.rel);
      const hit = f.state === "all" || (rel && rel.state === f.state);
      row.hidden = !hit;
      if (hit) n++;
    });
    $("#cl-count").textContent = `显示 ${n} / ${rels.length}`;
  };
  $("#cl-state").addEventListener("change", e => { f.state = e.target.value; apply(); });
  apply();
  $$(".pt-rel-row", list).forEach(b =>
    b.addEventListener("click", () => openDetail({ type: "edge", id: b.dataset.rel })));
  $$("#cl-events .pt-tl-item").forEach(b =>
    b.addEventListener("click", () => openDetail({ type: "event", id: b.dataset.event })));
}

/* ---------- 4. 知识图谱 ---------- */
function renderKnowledgePage(host) {
  const f = state.filters.knowledge;
  host.innerHTML = `<section class="view" aria-label="知识图谱">
    <div class="pt-toolbar">
      <input id="kn-q" class="pt-input" type="search" placeholder="搜索标题 / 标签 / 正文" value="${esc(f.q)}">
      <select id="kn-cat" class="pt-select"><option value="all">全部分类</option></select>
      <button class="sb-button sb-button-secondary" id="kn-refresh" type="button">刷新</button>
      <span class="pt-count" id="kn-count"></span>
    </div>
    <div class="pt-list" id="kn-list"><div class="pt-loading">加载中…</div></div>
  </section>`;

  $("#kn-q").addEventListener("change", e => { f.q = e.target.value.trim(); loadKnowledge(); });
  $("#kn-refresh").addEventListener("click", loadKnowledge);
  loadKnowledge();
}

async function loadKnowledge() {
  const f = state.filters.knowledge;
  const list = $("#kn-list");
  if (!list) return;
  list.innerHTML = '<div class="pt-loading">加载中…</div>';
  const p = new URLSearchParams({ limit: "300" });
  if (f.q) p.set("q", f.q);
  if (f.category !== "all") p.set("category", f.category);
  try {
    const body = await SB.api("/api/knowledge?" + p.toString());
    state.cache.knowledge = body.data;
    state.cache.knowledgeTotal = body.total;
    renderKnowledgeList();
  } catch (e) {
    list.innerHTML = `<div class="pt-empty-inline">加载失败：${esc(e.message)}</div>`;
  }
}

function renderKnowledgeList() {
  const f = state.filters.knowledge;
  const items = state.cache.knowledge || [];
  const list = $("#kn-list");
  if (!list) return;
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))];
  const sel = $("#kn-cat");
  if (sel && cats.length) {
    sel.innerHTML = '<option value="all">全部分类</option>' + cats
      .map(c => `<option value="${esc(c)}" ${f.category === c ? "selected" : ""}>${esc(c)}</option>`).join("");
    sel.onchange = e => { f.category = e.target.value; loadKnowledge(); };
  }
  list.innerHTML = items.map((k, i) => `
    <button class="sb-card pt-kn-card" data-idx="${i}" type="button">
      <div class="pt-task-head">
        <strong>${esc(k.title)}</strong>
        <span class="pt-tag">${esc(k.category || "未分类")}</span>
      </div>
      <p class="pt-task-sum">${esc(k.snippet || "暂无摘要")}</p>
      <div class="pt-task-foot">
        <span>${esc((k.tags || []).join(" / ") || "无标签")}</span>
        <span>${k.quality ? "质量 " + esc(k.quality) : "质量未标注"}</span>
        <span>${esc(k.updated || "—")}</span>
      </div>
    </button>`).join("") || '<div class="pt-empty-inline">暂无数据</div>';
  $("#kn-count").textContent = `共 ${state.cache.knowledgeTotal} 篇 · 已加载 ${items.length}`;
  $$(".pt-kn-card", list).forEach(b => b.addEventListener("click", () => {
    const k = items[Number(b.dataset.idx)];
    openPanel("知识文件", k.title, `
      <div class="pt-dp-sec"><h3>文件信息</h3><div class="pt-dl">
        ${detailRow("路径", esc(k.path))}
        ${detailRow("分类", esc(k.category || "—"))}
        ${detailRow("标签", esc((k.tags || []).join(" / ") || "—"))}
        ${detailRow("质量", esc(k.quality || "未标注"))}
        ${detailRow("更新时间", esc(k.updated || "—"))}
        ${detailRow("大小", (k.size / 1024).toFixed(1) + " KB")}
      </div></div>
      <div class="pt-dp-sec"><h3>正文摘要</h3><p class="pt-pre">${esc(k.snippet || "暂无数据")}</p></div>`);
  }));
}

/* ---------- 5. 记忆中心 ---------- */
async function renderMemoryPage(host) {
  host.innerHTML = `<section class="view" aria-label="记忆中心">
    <div class="pt-cols">
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">会话记忆</h3><div id="mem-sessions"><div class="pt-loading">加载中…</div></div></div>
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">Agent 运行记忆</h3><div id="mem-agents"><div class="pt-loading">加载中…</div></div></div>
    </div>
  </section>`;
  try {
    const b = await SB.api("/api/memory");
    const { sessions = [], agent_memory = [] } = b.data || {};
    $("#mem-sessions").innerHTML = sessions.length ? sessions.map(s => `
      <div class="pt-mem-row">
        <strong>${esc(s.thread_id)}</strong>
        <small>${esc(s.worker || "—")} · ${relTime(s.updated_at)}</small>
      </div>`).join("") : '<div class="pt-empty-inline">暂无数据</div>';
    $("#mem-agents").innerHTML = agent_memory.length ? agent_memory.map(a => `
      <div class="pt-mem-row">
        <strong>${esc(a.agent_id)}</strong>
        <small>最近心跳：${relTime(a.last_seen)}</small>
      </div>`).join("") : '<div class="pt-empty-inline">暂无数据</div>';
  } catch (e) {
    $("#mem-sessions").innerHTML = `<div class="pt-empty-inline">加载失败：${esc(e.message)}</div>`;
    $("#mem-agents").innerHTML = "";
  }
}

/* ---------- 6. 系统监控 ---------- */
function renderMonitorPage(host) {
  const m = SB.data.monitor || {};
  const sys = m.system || {};
  const hb = m.heartbeats || [];
  const queue = m.queue || {};
  const health = m.health || {};
  const alerts = Array.isArray(health.alerts) ? health.alerts : [];
  const queueRows = Object.entries(queue).map(([k, v]) => {
    const st = PAGE_STATUS[k] || { label: k, cls: "idle" };
    return `<div class="pt-mem-row"><strong>${esc(st.label)}</strong><small>${v} 条</small></div>`;
  }).join("") || '<div class="pt-empty-inline">暂无数据</div>';
  host.innerHTML = `<section class="view" aria-label="系统监控">
    <div class="pt-metrics">
      ${stat("线程心跳", hb.length, "运行中线程")}
      ${stat("执行中", queue.doing || 0, "任务")}
      ${stat("待领取", queue.pending || 0, "任务")}
      ${stat("死信", (queue.dead || 0), "需处理")}
      ${stat("告警", alerts.length, alerts.length ? "见下方" : "无告警")}
    </div>
    <div class="pt-cols">
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">线程心跳</h3><div id="mo-hb"></div></div>
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">队列深度</h3><div>${queueRows}</div></div>
    </div>
    <div class="pt-cols" style="margin-top:16px">
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">资源</h3><div class="pt-dl">
        ${detailRow("负载（1/5/15 分钟）", sys.loadavg ? sys.loadavg.join(" / ") : "暂无数据")}
        ${detailRow("内存总量", sys.mem_total_mb ? sys.mem_total_mb + " MB" : "暂无数据")}
        ${detailRow("可用内存", sys.mem_available_mb ? sys.mem_available_mb + " MB" : "暂无数据")}
      </div></div>
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">健康检查</h3>
        ${health && Object.keys(health).length ? `
          <div class="pt-dl">${detailRow("检查时间", esc(health.ts || health.time || "—"))}</div>
          <div class="pt-dp-sec" style="margin-top:12px"><h3>告警（${alerts.length}）</h3>
            ${alerts.length ? alerts.map(a => `<p class="pt-alert">${esc(typeof a === "string" ? a : JSON.stringify(a))}</p>`).join("") : '<small class="sb-text-tertiary">无告警</small>'}
          </div>
          <details class="pt-details"><summary>原始健康数据</summary><pre class="pt-pre">${esc(JSON.stringify(health, null, 2))}</pre></details>`
        : '<div class="pt-empty-inline">暂无数据</div>'}
      </div>
    </div>
  </section>`;
  $("#mo-hb").innerHTML = hb.length ? hb.map(h => `
    <div class="pt-mem-row">
      <strong>${esc(h.agent)}</strong>
      <small>${h.age_seconds == null ? "—" : h.age_seconds + " 秒前"} ${h.note ? "· " + esc(h.note) : ""}</small>
    </div>`).join("") : '<div class="pt-empty-inline">暂无数据</div>';
}

/* ---------- 7. 系统设置 ---------- */
function renderSettingsPage(host) {
  const modeText = { push: "SSE 实时推送", poll: "轮询（推送不可用）", error: "连接中断", idle: "未连接" }[SB.mode] || "未连接";
  const synced = SB.lastSync ? new Date(SB.lastSync).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  host.innerHTML = `<section class="view" aria-label="系统设置">
    <div class="pt-cols">
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">外观</h3>
        <p class="sb-text-secondary" style="font-size:13px;margin-bottom:12px">主题仅保存在本机浏览器，不影响后端。</p>
        <button class="sb-button sb-button-secondary" id="set-theme" type="button">切换深 / 浅色</button>
      </div>
      <div class="sb-card pt-panel"><h3 class="pt-panel-title">数据连接（只读）</h3><div class="pt-dl">
        ${detailRow("连接方式", esc(modeText))}
        ${detailRow("最近同步", esc(synced))}
        ${detailRow("只读口令", "已保存在本机浏览器（不回显）")}
      </div>
      <div style="margin-top:14px">
        <button class="sb-button sb-button-primary" id="set-conn" type="button">${SB.token ? "断开并清除口令" : "接入真实数据"}</button>
      </div></div>
    </div>
    <div class="sb-card pt-panel" style="margin-top:16px">
      <h3 class="pt-panel-title">Agent 管理（高风险）</h3>
      <p class="sb-text-secondary" style="font-size:13px;margin-bottom:12px">
        只读口令没有指挥权。此处的操作需要临时输入<b>指挥口令</b>，口令不入库、不保存、不回显；
        后端 API 会记录调用留痕。停用前系统会校验同类至少保留一个可用 Agent。
      </p>
      <div class="pt-form">
        <select id="mg-cmd" class="pt-select">
          <option value="disable-agent">停用 Agent</option>
          <option value="enable-agent">启用 Agent</option>
          <option value="add-agent">新增 Agent</option>
        </select>
        <input id="mg-id" class="pt-input" placeholder="Agent ID，如 research-worker" autocomplete="off">
        <select id="mg-kind" class="pt-select">
          <option value="worker">执行者</option>
          <option value="chief">指挥入口</option>
        </select>
        <input id="mg-token" class="pt-input" type="password" placeholder="指挥口令（仅本次使用）" autocomplete="off">
        <button class="sb-button sb-button-primary" id="mg-run" type="button">执行</button>
      </div>
      <div id="mg-result" class="pt-result" aria-live="polite"></div>
    </div>
  </section>`;

  $("#set-theme").addEventListener("click", () => $("#theme-toggle").click());
  $("#set-conn").addEventListener("click", () => {
    if (SB.token) SB.disconnect();
    else if (SB.connect) SB.connect();
  });
  $("#mg-run").addEventListener("click", async () => {
    const cmd = $("#mg-cmd").value;
    const id = $("#mg-id").value.trim();
    const kind = $("#mg-kind").value;
    const token = $("#mg-token").value;
    const out = $("#mg-result");
    if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(id)) {
      out.dataset.status = "error";
      out.textContent = "Agent ID 不合法：小写字母/数字/. _ -，长度 2-41";
      return;
    }
    if (!token) {
      out.dataset.status = "error";
      out.textContent = "请输入指挥口令（只读口令无法执行管理操作）";
      return;
    }
    const action = cmd === "add-agent" ? `新增 ${kind === "chief" ? "指挥入口" : "执行者"} ${id}`
      : (cmd === "disable-agent" ? `停用 ${id}` : `启用 ${id}`);
    if (!confirm(`确认${action}？\n该操作会写入审计留痕。`)) return;
    out.dataset.status = "pending";
    out.textContent = "执行中…";
    $("#mg-token").value = "";
    try {
      const args = { id };
      if (cmd === "add-agent") args.kind = kind;
      const res = await SB.post(cmd, args, token);
      out.dataset.status = res.ok ? "ok" : "error";
      out.textContent = res.ok ? `成功：${JSON.stringify(res).slice(0, 300)}` : `失败：${res.error || "未知错误"}`;
      if (res.ok) setTimeout(() => SB.refresh && SB.refresh(), 800);
    } catch (e) {
      out.dataset.status = "error";
      out.textContent = "失败：" + e.message;
    }
  });
}

/* ---------- 数据更新：平滑刷新当前页 ---------- */
document.addEventListener("sb:data", () => {
  if (window.SB3D && state.view === "command") SB3D.update(DEMO.agents, DEMO.edges);
  const host = $("#views");
  if (!host) return;
  const ae = document.activeElement;
  if (ae && host.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return;  // 输入中不打断
  if (state.view === "agents" || state.view === "collaboration" || state.view === "monitor") {
    renderPage(host, state.view);
  } else if (host.querySelector(".pt-empty")) {
    renderPage(host, state.view);           // 首次拿到数据后替换空态
  }
});

/* ---------- 启动 ---------- */
initTheme();
switchView("command");
