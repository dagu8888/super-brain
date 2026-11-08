/* Super-Brain 3.0 · 真实数据接入层（Phase 4 · SSE 实时推送）
   作用：把原型里的演示数据替换为 console_api 的真实数据；实时事件走 SSE，断线自动降级轮询。
   约束：只读；口令仅存本机浏览器 localStorage，可随时"断开"清除。 */
(function () {
  "use strict";
  const API = location.port === "18765"
    ? location.origin                                   // 由 API 服务托管时同源访问
    : "http://8.218.106.225:18765";                     // 本地静态预览时连线上服务
  const LS = "sb-viewer-token";
  const POLL_MS = 6000;
  const FULL_REFRESH_MS = 20000;   // 兜底全量刷新（Agent 状态/进度变化）
  const EVENT_REFRESH_MS = 2500;   // SSE 有新事件后触发一次全量刷新的最短间隔

  const NAMES = {
    "trae-chief": "TRAE", "dsh-chief": "DSH", "dsh2-chief": "DSH2",
    "maus-chief": "MAUS", "maus2-chief": "MAUS2", "grok-chief": "Grok",
    "deepseek-chief": "DeepSeek",
  };
  const ROLES = {
    "knowledge-worker": "知识整理", "archive-worker": "知识整理·并行",
    "research-worker": "情报研究", "analysis-worker": "情报分析",
    "chat-worker": "对话应答", "code-worker": "代码执行",
    "trae-developer": "开发执行", "test-agent-worker": "测试（已停用）",
  };
  const EVT_MAP = {
    inbox_note: "knowledge.created", kb_change: "knowledge.updated",
    task_progress: "task.progress", task_delegated: "task.assigned",
    task_linked: "task.progress", receipt: "task.completed",
    chief_result: "task.completed", chief_cmd: "agent.status_changed",
    manual: "agent.status_changed", agent_verified: "agent.created",
    heartbeat_lost: "system.warning", api_call: "agent.status_changed",
    api_auth_failed: "system.warning", inbox_materialized: "knowledge.created",
  };

  const SB = window.SB = {
    data: null,            // { ov, agents, rels, events, monitor, doing }
    token: null,
    mode: "idle",          // idle | push | poll | error
    lastSync: 0,
    api: null,
    post: null,
    refresh: null,
    connect: null,
    disconnect: null,
  };

  let es = null, pollTimer = null, fullTimer = null, refreshTimer = null;
  let refreshing = false, lastRefreshAt = 0, lastEventTs = 0;
  const seen = new Set();

  const el = (sel, root = document) => root.querySelector(sel);
  const hhmm = ts => {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toTimeString().slice(0, 8);
  };
  const rel = ts => {
    if (!ts) return "从未";
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  };

  function setConn(kind, text, hint) {
    const box = el("#conn-state");
    if (box) {
      box.dataset.status = kind;
      box.textContent = text;
    }
    const mode = el("#conn-mode");
    if (mode && hint) mode.textContent = hint;
    const badge = el("#live-badge");
    if (badge) {
      badge.textContent = kind === "working" ? (SB.mode === "push" ? "实时推送" : "实时数据")
        : (kind === "error" ? "连接中断" : "演示数据");
      badge.dataset.live = kind === "working" ? "1" : "0";
    }
    document.dispatchEvent(new CustomEvent("sb:mode", { detail: { mode: SB.mode, kind } }));
  }

  async function apiGet(path, token) {
    const res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) throw new Error("口令无效");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "接口错误");
    return body;
  }

  SB.api = (path, token) => apiGet(path, token || SB.token);
  SB.post = async (cmd, args, chiefToken) => {
    const res = await fetch(API + "/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + chiefToken },
      body: JSON.stringify({ cmd, args: args || {} }),
    });
    const body = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    if (res.status === 401) throw new Error("指挥口令无效（只读口令无指挥权）");
    return body;
  };

  async function loadAll(token) {
    const [ov, agents, rels, events, monitor, doing] = await Promise.all([
      apiGet("/api/overview", token),
      apiGet("/api/agents", token),
      apiGet("/api/relations", token),
      apiGet("/api/events?limit=40", token),
      apiGet("/api/monitor", token),
      apiGet("/api/tasks?status=doing&limit=20", token),
    ]);
    return { ov: ov.data, agents: agents.data, rels: rels.data,
             events: events.data, monitor: monitor.data, doing: doing.data };
  }

  function mapAgents(d) {
    const busy = {};
    d.doing.forEach(t => { busy[t.lease_owner] = t; });
    return d.agents.filter(a => a.status === "active").map(a => {
      const t = busy[a.agent_id];
      let currentTask = null;
      if (t) currentTask = `任务 #${t.id} · ${t.progress}% · 已过 ${t.elapsed_seconds}s / 预计 ${t.estimate_seconds}s`;
      else if (a.kind === "chief" && d.events.some(e => e.source === a.agent_id)) currentTask = "最近有调用记录";
      return {
        id: a.agent_id,
        name: NAMES[a.agent_id] || a.agent_id,
        role: ROLES[a.agent_id] || (a.kind === "chief" ? "指挥入口" : a.agent_id),
        kind: a.kind,
        status: a.live_status,
        currentTask,
        lastActive: rel(a.last_seen),
        last_seen: a.last_seen,
        capabilities: a.capabilities || [],
        task_types: a.task_types || [],
        permissions: a.permissions || {},
      };
    });
  }

  function mapEdges(d, agents) {
    const ids = new Set(agents.map(a => a.id));
    return d.rels.filter(r => ids.has(r.source) && ids.has(r.target)).map(r => ({
      id: `rel-${r.source}-${r.target}`,
      from: r.source,
      to: r.target,
      type: "delegation",
      taskId: null,
      time: r.last_at ? hhmm(r.last_at) : "—",
      state: r.state,
      evidence: r.evidence,
      taskCount: r.task_count,
      summary: r.evidence === "history"
        ? `历史派发 ${r.task_count} 次`
        : "默认路由（暂无派发记录）",
    }));
  }

  function mapEvent(e) {
    return {
      id: e.event_id,
      type: EVT_MAP[e.type] || "system.warning",
      source: NAMES[e.source] || e.source,
      rawSource: e.source,
      taskId: e.parent_id,
      text: `${NAMES[e.source] || e.source} · ${e.type}`,
      time: hhmm(e.created_at),
      ts: e.created_at,
      rawType: e.type,
    };
  }

  function apply(d) {
    SB.data = d;
    SB.lastSync = Date.now();
    d.events.forEach(e => { if (e.event_id) seen.add(e.event_id); });
    const agents = mapAgents(d);
    DEMO.agents = agents;
    DEMO.edges = mapEdges(d, agents);
    DEMO.events = d.events.map(mapEvent);
    DEMO.metrics = {
      chiefs: agents.filter(a => a.kind === "chief").length,
      workers: agents.filter(a => a.kind !== "chief").length,
      tasksRunning: d.ov.tasks_running,
      tasksPending: d.ov.tasks_pending,
      eventsToday: d.ov.events_today,
    };
    DEMO.real = {
      load: (d.monitor.system || {}).loadavg,
      mem: (d.monitor.system || {}).mem_available_mb,
      alerts: ((d.monitor.health || {}).alerts || []).length,
    };
    document.dispatchEvent(new CustomEvent("sb:data"));
  }

  async function refresh(token, silent) {
    if (refreshing) return;
    refreshing = true;
    const gap = Date.now() - lastRefreshAt;
    if (gap < EVENT_REFRESH_MS) {          // 事件风暴时合并刷新
      refreshing = false;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh(token, true), EVENT_REFRESH_MS - gap);
      return;
    }
    try {
      const d = await loadAll(token);
      lastRefreshAt = Date.now();
      apply(d);
      if (SB.mode === "push") setConn("working", "实时推送 · " + hhmm(Date.now() / 1000), "SSE 实时推送 · 只读");
      else setConn("working", "真实数据 · " + hhmm(Date.now() / 1000), "每 6 秒轮询 · 只读");
    } catch (err) {
      if (String(err.message).includes("口令")) {
        localStorage.removeItem(LS);
        stopAll();
        SB.mode = "error";
        setConn("error", "口令失效", "请重新接入");
        document.dispatchEvent(new CustomEvent("sb:error", { detail: String(err.message) }));
        if (!silent) alert("口令失效，请重新接入只读口令。");
      } else {
        setConn("error", "连接中断 · 数据可能已过期", "将在恢复后自动同步");
      }
    } finally {
      refreshing = false;
    }
  }

  /* ---------- SSE ---------- */
  function startSSE(token) {
    stopSSE();
    const since = lastEventTs || Math.floor(Date.now() / 1000) - 30;
    try {
      es = new EventSource(`${API}/api/stream?token=${encodeURIComponent(token)}&since=${since}`);
    } catch (e) {
      startPolling(token);
      return;
    }
    es.addEventListener("event", ev => {
      let e;
      try { e = JSON.parse(ev.data); } catch (_) { return; }
      if (!e.event_id || seen.has(e.event_id)) return;
      seen.add(e.event_id);
      lastEventTs = Math.max(lastEventTs, e.created_at || 0);
      SB.mode = "push";
      setConn("working", "实时推送 · " + hhmm(Date.now() / 1000), "SSE 实时推送 · 只读");
      // 立即把新事件插入时间轴，再合并触发一次全量刷新
      const mapped = mapEvent(e);
      DEMO.events = [mapped, ...(DEMO.events || [])].slice(0, 80);
      if (typeof state !== "undefined" && state.view === "command" && typeof renderTimelineList === "function") {
        try { renderTimelineList(); } catch (_) {}
      }
      document.dispatchEvent(new CustomEvent("sb:event", { detail: mapped }));
      refresh(token, true);
    });
    es.onopen = () => {
      const wasPolling = SB.mode === "poll";
      SB.mode = "push";
      stopPolling();
      setConn("working", "实时推送 · " + hhmm(Date.now() / 1000), "SSE 实时推送 · 只读");
      if (wasPolling) refresh(token, true);
    };
    es.onerror = () => {
      if (es && es.readyState === 2) {     // 服务端拒绝/连接关闭 → 明确降级
        stopSSE();
        SB.mode = "poll";
        startPolling(token);
        setConn("working", "轮询模式 · " + hhmm(Date.now() / 1000), "推送不可用，已自动降级为轮询");
      } else {
        setConn("waiting", "推送重连中…", "网络波动，浏览器自动重连");
      }
    };
  }
  function stopSSE() {
    if (es) { try { es.close(); } catch (_) {} }
    es = null;
  }
  function startPolling(token) {
    stopPolling();
    pollTimer = setInterval(() => refresh(token, true), POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  function stopAll() {
    stopSSE();
    stopPolling();
    if (fullTimer) clearInterval(fullTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    fullTimer = refreshTimer = null;
  }

  async function connect() {
    let token = localStorage.getItem(LS);
    if (!token) {
      token = prompt("输入控制台只读口令（只在本机浏览器保存）");
      if (!token) return;
      token = token.trim();
    }
    SB.token = token;
    setConn("waiting", "连接中…", "正在校验口令");
    try {
      const d = await loadAll(token);
      localStorage.setItem(LS, token);
      apply(d);
      SB.mode = "push";
      setConn("working", "实时推送 · " + hhmm(Date.now() / 1000), "SSE 实时推送 · 只读");
      stopAll();
      startSSE(token);                   // 优先 SSE；断线时 onerror 自动降级轮询
      fullTimer = setInterval(() => refresh(token, true), FULL_REFRESH_MS);
    } catch (err) {
      localStorage.removeItem(LS);
      SB.mode = "error";
      setConn("error", String(err.message), "请检查口令");
      alert("连接失败：" + err.message);
    }
  }

  function disconnect() {
    stopAll();
    localStorage.removeItem(LS);
    SB.mode = "idle";
    SB.token = null;
    SB.data = null;
    setConn("idle", "已断开 · 演示数据", "只读口令已清除");
    location.reload();
  }

  SB.connect = connect;
  SB.disconnect = disconnect;
  SB.refresh = () => SB.token && refresh(SB.token, true);

  window.addEventListener("DOMContentLoaded", () => {
    const btn = el("#live-connect");
    if (btn) {
      btn.addEventListener("click", () => (SB.token ? disconnect() : connect()));
    }
    if (localStorage.getItem(LS)) connect();
  });
})();
