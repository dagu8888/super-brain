---
layer: 编译层
type: 综合页
valid_from: 2026-11-08
confidence: 文档依据
title: Super-Brain 3.0 控制台 API 契约（Phase 4 · v1）
source: [70-Console/design/API-Contract.md]
status: 现行
partially_stale: true
---

# Super-Brain 3.0 控制台 API 契约（Phase 4 · v1）

> 版本：2026-11-08 ｜ 实现：`90-System/runtime/console_api.py` + `api_server.py`(GET 路由)
> 原则：**只读、不解耦 Runtime、不改 `/cmd`**；前端不直连数据库，全部经此适配层。

## 1. 鉴权

> 2026-11-13 P0-1：除 `GET /healthz` 与 `/console/` 静态资源外，读接口不再匿名返回业务数据。主人会话（`sb_owner` cookie 或等价 Bearer）、带 scope 的 Bearer，或与现有令牌的哈希比对可以通过。未带凭证返回 401。紧急回滚：`SB_ALLOW_ANON_READ=1`。详见 `40-Agents/读接口鉴权-迁移说明.md`。成功响应的路径和字段保持不变。

| 口令类型 | 配置位置 | 权限 |
|---|---|---|
| chief 口令 ×7 | `api_tokens.json` → `tokens` | 七指令 + 只读接口 |
| 控制台只读口令 | `api_tokens.json` → `viewers` | **仅 GET /api/***，调 `/cmd` 返回 401 |

请求头：`Authorization: Bearer <口令>`。错误口令与无口令均 401，并记 `api_auth_failed`（含来源 IP）。

CORS：允许 `*`（只读接口；跨域便于本地控制台调试），预检 `OPTIONS` 返回 204。

## 2. 统一响应

```json
{"ok": true, "ts": 1794116500, "data": ...}
{"ok": false, "error": "说明"}
```

列表类端点额外带 `total` / `limit` / `offset`。

## 3. 端点

| 端点 | 参数 | 说明 |
|---|---|---|
| `GET /healthz` | — | 免鉴权探活 |
| `GET /api/overview` | — | 首页统计：Agent 总数/在线/工作中/离线/久未使用、任务各状态、今日事件数。含 `console_rev: 1` |
| `GET /api/agents` | — | Agent 列表。`live_status` 按心跳判定；含 `presence_at`、`instances`（名册实例）、`current_task` |
| `GET /api/agents/{id}` | — | 单个 Agent + 最近 12 条非 dead 任务（含指令原文、结果路径；进行中的那条带事件） |
| `GET /api/tasks` | `status`,`type`,`agent`,`q`,`limit`(≤200),`offset` | 任务列表。**未传 status 时默认排除 dead**（`excluded_dead: true`），条件走 `status IN (...)` |
| `GET /api/knowledge/file` | `path` | 知识类目录全文（Markdown/纯文本）。拒绝穿越、`.git`、`api_tokens`、`state.db` |
| `GET /api/tasks/{id}` | — | 任务全量（含 payload）+ 关联事件 20 条 |
| `GET /api/events` | `since`(秒),`type`,`limit`(≤200) | 事件流，倒序 |
| `GET /api/stream` | `token`,`since`(秒) | **SSE 实时推送**（见第 5 节） |
| `GET /api/monitor` | — | 线程心跳 + 队列深度 + health 最近一次 + loadavg/内存 |
| `GET /api/knowledge` | `limit`(≤500),`q`,`category` | 知识文件列表（frontmatter：title/category/tags/quality/updated + 正文摘要 snippet；q 搜索标题/路径/标签/正文） |
| `GET /api/memory` | — | 会话列表 + Agent 运行记忆（`last_seen`） |
| `GET /api/relations` | — | 协作通道：`source→target`、`evidence`(history/default_route)、`task_count`、`state`(active/idle) |

### 任务进度字段（自学习）

`/api/tasks` 与 `/api/tasks/{id}` 额外返回：

| 字段 | 说明 |
|---|---|
| `progress` | done=100，pending=0，doing=已过/预计×100（封顶 95），失败类=null |
| `estimate_seconds` | 同类任务**最近 20 条完成耗时的中位数**，无样本回退 120 秒 |
| `elapsed_seconds` | 领取至今秒数 |
| `estimate_samples` | 参与估算的样本数（越多越准，随运行自动成长） |

样本来自 `tasks` 表自身历史（`done_at - claimed_at`），无新增表、无迁移，越跑越准。

## 3.1 接入 / 待批示字段（2026-11-08 追加）

| 字段 | 来源 | 口径 |
|---|---|---|
| `ever_connected` | 有效出现时间非空 | 是否接入过。有效出现时间见下 |
| `pending_decisions` | 该 chief 名下 `tasks.status='pending' AND priority>=1` 的任务数 | 关键决策等待批示；无则为 0，不编造 |
| `pending_decisions`（overview） | 同上，全局合计 | 供调度中枢节点展示 |
| `presence_at` | 见下 | 最后一次被看见的 Unix 秒 |
| `instances` | `registry.kind='instance'` 且 `agent_ref=agent_id` | 在册实例名、位置、该实例心跳时间 |

在线判定（chief 与 worker 相同，不再因为 kind=chief 就永远在线）：

有效出现时间 = `max(agents.last_seen, heartbeats.ts)`。心跳键有两种：进程自己的 `agent_id`，以及名册实例名（`heartbeats.agent` = `registry.name`，再经 `agent_ref` 折回 chief）。5 分钟（300 秒）内有出现才算在线。

| `live_status` | 含义 |
|---|---|
| `working` | 在线，且名下有 `status='doing'` 的任务 |
| `idle` | 在线，没有进行中的任务 |
| `offline` | 曾经出现，但超过 5 分钟 |
| `unused` | 从未出现（久未使用） |

### 协作线口径（必须遵守）

- **线全部预先生成**：有真实派发记录的画 `history`，无记录的入口补一条 `default_route`（默认路由 chat-worker，规则层真实兜底）。
- **不发光**：`state=idle` 时为实线 + 透明度 0.22。
- **才发光**：`state=active`（对应执行者当前有 `doing` 任务）才加流动光点。
- 连线不表示"此刻正在协作"，只表示"可委派的通道"；点击可看派发次数/时间。

## 3.2 知识全文与在场心跳（2026-11-10）

`GET /api/knowledge/file?path=` 只读 `00-Inbox/`、`10-Knowledge/`、`20-Skills/`、`30-Reviews/`、`40-Agents/`、`60-Outputs/` 下的 `.md` / `.txt`。解析后的真实路径必须仍落在这些前缀里。拒绝 `..`、`.git`、绝对路径，以及文件名命中 `api_tokens*`、`llm.json`、`state.db*`、`.env`、`.pem`、`.key`。缺失文件返回 `文件不存在`（与未知路由的 `not found` 区分，便于旧前端降级）。

`GET /api/stream?instance=` 通过名册校验后：`heartbeats.agent` 仍写实例名；`agents.last_seen` 改为更新 `registry.agent_ref`，不再把实例名当作 `agent_id`。

## 4. 状态映射（前端展示 ← 后端真实字段）

| 前端 | 来源 |
|---|---|
| Agent `working` | 5 分钟内有心跳，且 `tasks.status='doing' AND lease_owner=agent_id` |
| Agent `idle` | 5 分钟内有心跳，且无进行中任务 |
| Agent `offline` | 曾经出现，但超过 300 秒（chief 同样判离线） |
| Agent `unused` | 从未有 `last_seen` 或心跳（久未使用） |
| Agent `collaborating/waiting/completed/error` | **当前后端无对应字段 → 前端不显示**（不推断、不编造） |
| Task 状态 | 直接透传 `tasks.status`（pending/doing/done/failed/dead/cancelled） |
| 进度百分比 | 后端按「同类任务近 20 次完成耗时中位数」估算（见上），仅 `doing` 有值且封顶 95%；无样本不显示 |
| 系统健康 | `health-*.jsonl` 末行 `alerts` 数组（空 = 无告警），不合成"健康分数" |
| 成本 | **无采集 → 不展示** |

## 5. 实时性（SSE 推送 + 轮询兜底）

### 5.1 `GET /api/stream`

浏览器 `EventSource` 无法自定义请求头，因此该端点接受 **查询参数 `token`**（其余接口仍用 `Authorization`）。
连接数上限 8，单连接最长 600 秒后正常结束，浏览器会自动重连。

```
GET /api/stream?token=<只读或指挥口令>&since=<秒级时间戳>
```

响应 `Content-Type: text/event-stream`：

```
id: evt_xxx
event: event
data: {"event_id":"evt_xxx","source":"trae-chief","type":"task_delegated","priority":5,"status":"new","parent_id":123,"created_at":1794116500}

: ping
```

| 项 | 规则 |
|---|---|
| 增量 | 服务端从 `events.created_at >= since` 启动，1 秒轮询数据库增量推送 |
| 去重 | 事件以 `event_id` 去重；重叠窗口（同秒事件）由 `seen` 集合兜底 |
| 心跳 | 15 秒无数据写一行 `: ping` 注释，防代理断连 |
| 保活上限 | 单连接 10 分钟，客户端自动重连（`Last-Event-ID` 不依赖，重连用 `since`） |
| 鉴权失败 | 401，并记 `api_auth_failed`（日志只记 `/api/stream`，不记录 token） |
| 过载 | 并发超过 8 返回 429 |

### 5.2 前端策略（`live.js`）

1. 连接成功后 **优先 SSE**；`EventSource` 关闭（如服务端拒绝）→ 自动降级为 6 秒轮询。
2. 另有 20 秒全量刷新校准 Agent 状态与任务进度（进度随时间变化，事件流本身不推送进度）。
3. 侧栏三态：`实时推送` / `轮询模式` / `连接中断`；断开时明确提示数据可能过期。
4. 新事件到达时立即插入首页时间轴（不重置网络图视角），随后合并触发一次全量刷新。

## 6. 已验证（2026-11-08 实测，服务器本机）

| 项 | 结果 |
|---|---|
| `/healthz` | 200 |
| overview / agents / tasks / events / monitor / knowledge / memory / relations | 全部 200 |
| 无口令 / 错口令 | 401 |
| 只读口令调 `POST /cmd` | 401（指挥权隔离生效） |
| 不存在任务 `GET /api/tasks/999999` | 404 |
| `limit=999` | 200，自动截断为 200 |
| CORS 预检 `OPTIONS` | 204 |
| `/api/stream` 建连 | 1.2ms，`event-stream` 正常 |
| SSE 事件产生 → 客户端可读 | 407ms（服务端 1 秒增量轮询） |
| SSE 不同 `event_id` 去重 | 生效（同事件只推一次） |
| `/api/stream?token=bad` | 401 |

接口延迟（服务器本机，20 次）：overview P50 2.0ms / P95 2.3ms；agents 2.0 / 2.1；tasks 2.7 / 2.7；monitor 2.2 / 2.3；knowledge（25 篇含正文摘要）14.9 / 15.2。

## 7. 已知限制（如实）

1. 明文 HTTP（用户已确认接受）；仅依赖口令强度 + 失败留痕。
2. `/api/events` 与 `/api/tasks/{id}` 会返回任务/事件 payload 摘要，可能含用户私人笔记内容 → 只读口令视同隐私凭据保管。
3. 无分页游标，超大结果集用 limit/offset 截断；知识列表最多 500。
4. 协作线来自「历史真实派发记录 + 默认路由兜底」，只表示可委派通道；当前状态仅为 `active/idle` 两态，没有独立的协作事件表。
5. SSE 并发上限 8、单连接 10 分钟；超出返回 429 / 自动重连。未做 IP 级限流（服务仅内网口径使用，公网暴露需另加网关）。
6. `/api/tasks` 不带 `status` 时不再返回 dead。要看死信必须显式 `status=dead`（仍带 limit）。这是为了避开历史死信风暴。

## 操作台 v2 只读接口（2026-11-11，console_v2.py）

均为 GET、只读，且要主人会话或令牌；字段与 2.8.0 相同。写入仍只走 `POST /cmd` 并要 chief 口令。

| 端点 | 说明 |
|---|---|
| `/api/dashboard` | KPI（在线/近1h/24h/累计消息、事件、队列）、各 Agent 异常计数、点名历史（每节点首条回复耗时、重复回复数、未回名单）、近24h分时消息与消息连线、最近 80 条消息 |
| `/api/server` | 服务器健康：开机时长、中台服务运行时长、负载、内存、磁盘、状态库体积、TLS 证书到期（读本地 Caddy 证书文件，不联网） |
| `/api/messages?agent=<id>&limit=` | 某 Agent 发出或收到（含其实例名）的消息，新→旧 |
| `/api/stream?observe=1` | SSE 观察模式：不带 instance 时推送全部消息（与 `/api/messages` 同口径），但不再免口令；带 instance 仍要节点令牌 |

异常口径：死信=点名该 Agent（payload.to_agent / payload.to 经名册折回）的 dead 任务（5 分钟统计一次）；
未认领=点名该 Agent、pending 且超过 10 分钟无人领；心跳过期=曾接入但超过 5 分钟无在场信号（实例逐个计）。
在线只认心跳/在场；执行中只认任务租约。
