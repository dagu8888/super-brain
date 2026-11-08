/* ==========================================================================
   Phase 3 原型 · 演示数据
   说明：本文件为静态演示数据，仅用于原型评审；数值风格取自 2026-11-08 审计事实，
   但并非实时数据。Phase 4 将由 console_api / WebSocket 真实数据替换本文件。
   ========================================================================== */

const DEMO = {
  generatedAt: "2026-11-08 12:40（演示快照）",

  metrics: {
    agentsOnline: 10,
    tasksRunning: 2,
    tasksPending: 0,
    alerts: 0,
    eventsToday: 12,
  },

  /* kind: chief=指挥入口（非常驻） / worker=执行者（常驻线程）
     status 取值对应 Agent 7 态：idle/working/collaborating/waiting/completed/error/offline */
  agents: [
    { id: "trae-chief",      name: "TRAE",            role: "幕僚长入口", kind: "chief",  status: "working",       currentTask: "指挥 V3.0 原型开发",   lastActive: "刚刚",     x: 80,  y: 36 },
    { id: "dsh-chief",       name: "DSH",             role: "多智能体入口", kind: "chief", status: "idle",          currentTask: null,                   lastActive: "12 分钟前", x: 300, y: 36 },
    { id: "grok-chief",      name: "Grok",            role: "外脑入口",   kind: "chief",   status: "idle",          currentTask: null,                   lastActive: "34 分钟前", x: 520, y: 36 },
    { id: "deepseek-chief",  name: "DeepSeek",        role: "外脑入口",   kind: "chief",   status: "idle",          currentTask: null,                   lastActive: "1 小时前",  x: 740, y: 36 },
    { id: "maus-chief",      name: "MAUS",            role: "外脑入口",   kind: "chief",   status: "idle",          currentTask: null,                   lastActive: "2 小时前",  x: 960, y: 36 },
    { id: "research-worker", name: "research-worker", role: "情报研究",   kind: "worker",  status: "working",       currentTask: "多智能体记忆机制研究",  lastActive: "1 分钟前",  x: 80,  y: 330 },
    { id: "knowledge-worker",name: "knowledge-worker",role: "知识整理",   kind: "worker",  status: "collaborating", currentTask: "归档设计系统 Decision", lastActive: "刚刚",     x: 300, y: 330 },
    { id: "chat-worker",     name: "chat-worker",     role: "对话应答",   kind: "worker",  status: "idle",          currentTask: null,                   lastActive: "20 分钟前", x: 520, y: 330 },
    { id: "code-worker",     name: "code-worker",     role: "代码执行",   kind: "worker",  status: "waiting",       currentTask: "等待研究结论交接",      lastActive: "6 分钟前",  x: 740, y: 330 },
    { id: "trae-developer",  name: "trae-developer",  role: "开发执行",   kind: "worker",  status: "working",       currentTask: "开发 Phase 3 高保真原型", lastActive: "刚刚",    x: 960, y: 330 },
  ],

  /* type: delegation 委派 / message 消息 / handoff 交接 / feedback 反馈 / shared_context 共享上下文
     state: active=协作进行中（流动动画） / recent=近期协作（静态虚线） */
  edges: [
    { id: "e1", from: "trae-chief",      to: "trae-developer",  type: "delegation",     taskId: "task_023", time: "12:31", state: "active", summary: "下达 Phase 3 原型开发任务" },
    { id: "e2", from: "trae-chief",      to: "knowledge-worker",type: "delegation",     taskId: "task_024", time: "12:32", state: "active", summary: "归档 V3 设计系统 Decision" },
    { id: "e3", from: "research-worker", to: "knowledge-worker",type: "handoff",        taskId: "task_021", time: "12:05", state: "active", summary: "研究成果移交归档" },
    { id: "e4", from: "dsh-chief",       to: "research-worker", type: "delegation",     taskId: "task_019", time: "10:48", state: "recent", summary: "委派记忆机制研究" },
    { id: "e5", from: "chat-worker",     to: "knowledge-worker",type: "feedback",       taskId: "task_016", time: "09:52", state: "recent", summary: "会话要点回流知识库" },
    { id: "e6", from: "deepseek-chief",  to: "code-worker",     type: "delegation",     taskId: "task_014", time: "09:10", state: "recent", summary: "脚本修复委派" },
    { id: "e7", from: "knowledge-worker",to: "code-worker",     type: "shared_context", taskId: "task_020", time: "11:20", state: "recent", summary: "共享检索片段 5 条" },
  ],

  /* 事件类型与配色遵循总指令 §14.2 */
  eventTypeMeta: {
    "task.created":          { label: "任务创建",   color: "var(--sb-info)" },
    "task.assigned":         { label: "任务分配",   color: "var(--sb-info)" },
    "task.started":          { label: "任务开始",   color: "var(--sb-primary)" },
    "task.progress":         { label: "任务进度",   color: "var(--sb-primary)" },
    "task.handoff":          { label: "任务交接",   color: "var(--sb-collaborating)" },
    "task.completed":        { label: "任务完成",   color: "var(--sb-success)" },
    "task.failed":           { label: "任务失败",   color: "var(--sb-danger)" },
    "agent.created":         { label: "Agent 创建", color: "var(--sb-info)" },
    "agent.started":         { label: "Agent 启动", color: "var(--sb-info)" },
    "agent.status_changed":  { label: "状态变更",   color: "var(--sb-warning)" },
    "collaboration.started": { label: "协作开始",   color: "var(--sb-collaborating)" },
    "collaboration.message": { label: "协作消息",   color: "var(--sb-collaborating)" },
    "collaboration.ended":   { label: "协作结束",   color: "var(--sb-collaborating)" },
    "knowledge.created":     { label: "知识新增",   color: "var(--sb-success)" },
    "knowledge.updated":     { label: "知识更新",   color: "var(--sb-success)" },
    "system.warning":        { label: "系统警告",   color: "var(--sb-warning)" },
    "system.error":          { label: "系统错误",   color: "var(--sb-danger)" },
  },

  collabTypeMeta: {
    delegation: "任务委派",
    message: "消息传递",
    handoff: "任务交接",
    feedback: "结果反馈",
    shared_context: "共享上下文",
  },

  events: [
    { id: "evt_012", type: "task.created",          time: "12:32:10", source: "trae-chief",                       taskId: "task_024", text: "创建任务：归档 V3 设计系统 Decision" },
    { id: "evt_011", type: "collaboration.started", time: "12:31:02", source: "trae-chief → trae-developer",      taskId: "task_023", text: "开始协作：Phase 3 原型开发" },
    { id: "evt_010", type: "knowledge.created",     time: "12:05:44", source: "knowledge-worker",                 taskId: "task_021", text: "新增知识：Decisions/收件箱分类规则 v3" },
    { id: "evt_009", type: "task.handoff",          time: "12:05:02", source: "research-worker → knowledge-worker", taskId: "task_021", text: "任务交接：研究成果移交归档" },
    { id: "evt_008", type: "task.completed",        time: "11:58:37", source: "research-worker",                  taskId: "task_019", text: "任务完成：多智能体记忆机制研究" },
    { id: "evt_007", type: "task.progress",         time: "11:40:15", source: "research-worker",                  taskId: "task_019", text: "进度更新：完成 3/4 子任务" },
    { id: "evt_006", type: "collaboration.message", time: "11:20:08", source: "knowledge-worker → code-worker",   taskId: "task_020", text: "共享上下文：检索片段 5 条" },
    { id: "evt_005", type: "agent.status_changed",  time: "10:49:30", source: "code-worker",                      taskId: null,       text: "状态变更：idle → waiting" },
    { id: "evt_004", type: "task.assigned",         time: "10:48:11", source: "dsh-chief",                        taskId: "task_019", text: "任务分配：research-worker 领取" },
    { id: "evt_003", type: "task.created",          time: "10:48:03", source: "dsh-chief",                        taskId: "task_019", text: "创建任务：多智能体记忆机制研究" },
    { id: "evt_002", type: "system.warning",        time: "10:12:56", source: "health.py",                        taskId: null,       text: "提醒：LLM 熔断器短暂开合（已自愈）" },
    { id: "evt_001", type: "agent.started",         time: "08:00:00", source: "super-brain.service",              taskId: null,       text: "运行时启动：9 线程就绪" },
  ],

  /* 模拟新事件池（演示「新事件自然进入 / 暂停后待查看」交互） */
  livePool: [
    { type: "task.progress",         source: "trae-developer",   taskId: "task_023", text: "进度更新：原型网络图渲染完成" },
    { type: "collaboration.message", source: "trae-chief → trae-developer", taskId: "task_023", text: "补充要求：加入缩放与平移" },
    { type: "knowledge.created",     source: "knowledge-worker", taskId: "task_024", text: "新增知识：Decisions/V3 设计系统定稿" },
  ],
};
