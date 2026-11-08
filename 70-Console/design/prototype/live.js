/* Super-Brain 3.0 · 真实数据接入层（Phase 4）
   作用：把原型里的演示数据替换为 console_api 的真实数据，并定时刷新。
   约束：只读；口令仅存本机浏览器 localStorage，可随时"断开"清除。 */
(function () {
  "use strict";
  const API = "http://8.218.106.225:18765";
  const LS = "sb-viewer-token";
  const POLL_MS = 6000;

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

  let timer = null, connected = false;

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

  function setConn(kind, text) {
    const box = el("#conn-state");
    if (box) {
      box.dataset.status = kind;
      box.textContent = text;
    }
    const badge = el("#live-badge");
    if (badge) {
      badge.textContent = kind === "working" ? "实时数据" : (kind === "error" ? "连接中断" : "演示数据");
      badge.dataset.live = kind === "working" ? "1" : "0";
    }
  }

  async function apiGet(path, token) {
    const res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) throw new Error("口令无效");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "接口错误");
    return body.data;
  }

  async function loadAll(token) {
    const [ov, agents, rels, events, monitor, doing] = await Promise.all([
      apiGet("/api/overview", token),
      apiGet("/api/agents", token),
      apiGet("/api/relations", token),
      apiGet("/api/events?limit=40", token),
      apiGet("/api/monitor", token),
      apiGet("/api/tasks?status=doing&limit=20", token),
    ]);
    return { ov, agents, rels, events, monitor, doing };
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
      summary: r.evidence === "history"
        ? `历史派发 ${r.task_count} 次`
        : "默认路由（暂无派发记录）",
    }));
  }

  function mapEvents(d) {
    return d.events.map(e => ({
      id: e.event_id,
      type: EVT_MAP[e.type] || "system.warning",
      source: NAMES[e.source] || e.source,
      taskId: e.parent_id,
      text: `${NAMES[e.source] || e.source} · ${e.type}`,
      time: hhmm(e.created_at),
      rawType: e.type,
    }));
  }

  function apply(d) {
    const agents = mapAgents(d);
    DEMO.agents = agents;
    DEMO.edges = mapEdges(d, agents);
    DEMO.events = mapEvents(d);
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
    if (state.view === "command") switchView("command");
  }

  async function refresh(token) {
    try {
      const d = await loadAll(token);
      apply(d);
      connected = true;
      setConn("working", "真实数据 · " + new Date().toTimeString().slice(0, 8));
    } catch (err) {
      connected = false;
      if (String(err.message).includes("口令")) {
        localStorage.removeItem(LS);
        setConn("error", "口令失效");
        stop();
      } else {
        setConn("error", "连接中断 · 数据可能已过期");
      }
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function connect() {
    let token = localStorage.getItem(LS);
    if (!token) {
      token = prompt("输入控制台只读口令（只在本机浏览器保存）");
      if (!token) return;
      token = token.trim();
    }
    setConn("waiting", "连接中…");
    try {
      const d = await loadAll(token);
      localStorage.setItem(LS, token);
      apply(d);
      setConn("working", "真实数据 · " + new Date().toTimeString().slice(0, 8));
      stop();
      timer = setInterval(() => refresh(token), POLL_MS);
    } catch (err) {
      localStorage.removeItem(LS);
      setConn("error", String(err.message));
      alert("连接失败：" + err.message);
    }
  }

  function disconnect() {
    stop();
    localStorage.removeItem(LS);
    setConn("idle", "已断开 · 演示数据");
    location.reload();
  }

  window.addEventListener("DOMContentLoaded", () => {
    const btn = el("#live-connect");
    if (btn) {
      btn.addEventListener("click", () => (connected || timer) ? disconnect() : connect());
    }
    if (localStorage.getItem(LS)) connect();
  });
})();
