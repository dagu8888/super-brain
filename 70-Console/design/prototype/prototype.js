/* ==========================================================================
   Phase 3 原型 · 交互逻辑
   数据来源：data.js 静态演示数据（Phase 4 替换为 console_api + WebSocket）
   ========================================================================== */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NODE_W = 230, NODE_H = 76, WORLD_W = 1200, WORLD_H = 440;

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

/* 其余 7 页线框（Phase 4 接入真实数据） */
const WF = {
  agents: { intro: "Agent 花名册：卡片网格而非密集表格；点击卡片在右侧打开统一详情面板。", blocks: [
    ["筛选工具条", "状态（7 态）/ 类型（chief·worker）/ 关键词搜索"],
    ["Agent 卡片网格", "AgentCard ×10：名称、角色、状态徽章、当前任务、最近活动时间"],
    ["统一详情面板", "基本信息 / 当前任务 / 最近活动 / 协作对象 / 历史任务 / 健康 / 权限摘要"],
    ["高风险操作区", "停止·重启 Agent：确认框 + 后端权限校验 + 审计留痕"],
  ]},
  tasks: { intro: "任务全生命周期：状态来自 tasks 表真实映射，时间线由真实事件渲染。", blocks: [
    ["工具条", "搜索 / 状态 / 优先级 / Agent / 创建时间 / 排序"],
    ["任务列表", "TaskCard：标题、状态徽章、优先级、当前 Agent、最近事件"],
    ["任务时间线", "创建→分配→领取→执行→协作→交接→完成；允许分支与重试，不强制线性"],
    ["进度展示纪律", "仅有可靠数据才显示百分比，否则显示当前阶段 + 最近事件"],
  ]},
  collaboration: { intro: "Agent 间协作追踪：每条记录都可追溯到真实事件 ID。", blocks: [
    ["进行中的协作", "协作链路图：委派 / 消息 / 交接 / 反馈 / 共享上下文"],
    ["协作历史", "按 Agent、Task、时间筛选；点击跳转事件详情"],
    ["协作异常", "交接超时、消息失败等异常单列"],
  ]},
  knowledge: { intro: "空间感知识网络：2D 交互图谱起步，预留 3D 扩展接口。", blocks: [
    ["图谱画布", "节点（Agent/Task/Document/Concept/Memory/Event）+ 语义关系边"],
    ["图谱工具", "搜索定位 / 类型筛选 / 关系筛选 / 邻居展开 / 分支收起 / 路径追踪 / 一键重置"],
    ["增量更新纪律", "新节点增量进入，不重置布局；用户浏览时不打断视图"],
  ]},
  memory: { intro: "现有记忆系统的可视化管理，底层不重构；当前 sessions 仅 7 条，如实展示。", blocks: [
    ["记忆分 Tab", "全局记忆 / Agent 记忆 / 项目记忆"],
    ["记忆列表", "内容摘要、来源、关联任务、关联知识、更新时间"],
    ["写操作纪律", "修改/删除/合并必须经后端权限校验与审计"],
  ]},
  monitor: { intro: "系统健康实况：仅展示后端真实采集的数据，没有的一律「暂无数据」。", blocks: [
    ["服务状态", "runtime / api-server / WebSocket 适配层（Phase 4 新增）"],
    ["线程心跳", "Router / Reaper / 5 Worker / api-server：heartbeats 表"],
    ["资源与队列", "health.py 七项检查：磁盘、内存、队列深度、死信、同步状态"],
    ["异常事件", "system.warning / system.error 持久化告警列表"],
  ]},
  settings: { intro: "偏好与系统设置：主题等客户端偏好存本地，系统设置走后端校验。", blocks: [
    ["外观", "主题：浅色 / 深色 / 跟随系统"],
    ["通知", "级别开关；严重异常进入持久告警列表"],
    ["连接", "WebSocket 状态、断线补偿、数据过期提示"],
    ["高风险区", "重启服务、修改权限等：确认框 + 审计"],
  ]},
};

const state = {
  view: "command",
  selected: null,            // 选中 Agent id
  panel: { target: null, pinned: false, history: [] },
  net: { scale: 1, tx: 0, ty: 0 },
  tl: { paused: false, filter: "all", pending: [] },
  sim: 0,
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
  $("#page-title").textContent = NAV.find(n => n.id === id).label;
  renderNav();
  const host = $("#views");
  host.innerHTML = "";
  if (id === "command") renderCommand(host);
  else renderWireframe(host, id);
}

/* ---------- 指挥中心 ---------- */
function renderCommand(host) {
  const m = DEMO.metrics;
  host.innerHTML = `
  <section class="view" aria-label="指挥中心">
    <div class="pt-metrics">
      ${stat("在线 Agent", m.agentsOnline, "全部活跃")}
      ${stat("执行中任务", m.tasksRunning, "2 个协作链路")}
      ${stat("待处理", m.tasksPending, "无积压")}
      ${stat("异常", m.alerts, "系统正常")}
      ${stat("今日事件", m.eventsToday, "实时流入")}
    </div>

    <div class="sb-card pt-net-card">
      <div class="pt-net-head">
        <h3>Agent 协作网络</h3>
        <div class="pt-net-tools">
          <button class="sb-button sb-button-secondary" data-zoom="out" type="button">−</button>
          <button class="sb-button sb-button-secondary" data-zoom="in" type="button">＋</button>
          <button class="sb-button sb-button-secondary" data-zoom="fit" type="button">适配</button>
          <button class="sb-button sb-button-secondary" data-zoom="reset" type="button">重置</button>
        </div>
      </div>
      <div class="pt-net" id="net" aria-label="Agent 协作网络画布">
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
        <button class="sb-button sb-button-ghost" id="tl-sim" type="button">模拟新事件（演示）</button>
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
  $("#tl-sim").addEventListener("click", simulateEvent);
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
            stroke="var(--sb-primary)" stroke-width="${active ? 2.5 : 1.5}"
            opacity="${active ? 0.9 : 0.4}" ${active ? "" : 'stroke-dasharray="5 6"'}/>
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
  fitNet();
  net.addEventListener("wheel", e => {
    e.preventDefault();
    const r = net.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    zoomAt(mx, my, e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });
  let drag = null;
  net.addEventListener("pointerdown", e => {
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
    const act = b.dataset.zoom, net = $("#net");
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
    const events = DEMO.events.filter(e => e.source.includes(a.id)).slice(0, 3);
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
      <div class="pt-dp-sec"><h3>健康</h3><div class="pt-dl">
        ${detailRow("心跳", "正常（演示）")}
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

/* ---------- 线框视图 ---------- */
function renderWireframe(host, id) {
  const wf = WF[id];
  host.innerHTML = `
  <section class="view" aria-label="${NAV.find(n => n.id === id).label}">
    <span class="wf-note">线框原型 · Phase 4 接入真实数据</span>
    <p class="sb-text-secondary" style="margin-bottom:20px">${wf.intro}</p>
    <div class="wf-grid cols-2">
      ${wf.blocks.map(([b, s]) => `<div class="wf-block"><b>${b}</b><small>${s}</small></div>`).join("")}
    </div>
  </section>`;
}

/* ---------- 启动 ---------- */
initTheme();
switchView("command");
