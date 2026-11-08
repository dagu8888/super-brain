# Super-Brain 3.0 控制台 API 契约（Phase 4 · v1）

> 版本：2026-11-08 ｜ 实现：`90-System/runtime/console_api.py` + `api_server.py`(GET 路由)
> 原则：**只读、不解耦 Runtime、不改 `/cmd`**；前端不直连数据库，全部经此适配层。

## 1. 鉴权

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
| `GET /api/overview` | — | 首页统计：Agent 总数/在线/工作中、任务各状态、今日事件数 |
| `GET /api/agents` | — | Agent 列表（含 `live_status`、`current_task_id`） |
| `GET /api/agents/{id}` | — | 单个 Agent + 最近 10 条任务 |
| `GET /api/tasks` | `status`,`type`,`agent`,`limit`(≤200),`offset` | 任务列表（summary 截断 200 字） |
| `GET /api/tasks/{id}` | — | 任务全量（含 payload）+ 关联事件 20 条 |
| `GET /api/events` | `since`(秒),`type`,`limit`(≤200) | 事件流，倒序 |
| `GET /api/monitor` | — | 线程心跳 + 队列深度 + health 最近一次 + loadavg/内存 |
| `GET /api/knowledge` | `limit`(≤500) | 知识文件列表（frontmatter：title/category/tags/quality/updated） |
| `GET /api/memory` | — | 会话列表 + Agent 运行记忆（`last_seen`） |

## 4. 状态映射（前端展示 ← 后端真实字段）

| 前端 | 来源 |
|---|---|
| Agent `working` | `tasks.status='doing' AND lease_owner=agent_id` |
| Agent `idle` | `status='active'` 且无进行中任务 |
| Agent `offline` | `kind='worker'` 且 `last_seen` 超 300 秒 |
| Agent `collaborating/waiting/completed/error` | **当前后端无对应字段 → 前端不显示**（不推断、不编造） |
| Task 状态 | 直接透传 `tasks.status`（pending/doing/done/failed/dead/cancelled） |
| 进度百分比 | **后端无可靠进度字段 → 不显示百分比**，改展示阶段与最近事件 |
| 系统健康 | `health-*.jsonl` 末行 `alerts` 数组（空 = 无告警），不合成"健康分数" |
| 成本 | **无采集 → 不展示** |

## 5. 实时性

- 当前为**轮询**（建议 3 秒 overview/agents/tasks，5 秒 events）。
- WebSocket/SSE 推送属 Phase 4 后半段，需新增 `ws_adapter`（不影响本节契约）。
- `events` 无自增序号，用 `created_at`（秒）+ `event_id` 去重排序；`since` 用于增量拉取，重叠窗口由前端去重。

## 6. 已验证（2026-11-08 实测）

| 项 | 结果 |
|---|---|
| 九个端点 | 全部 200 |
| 无口令 / 错口令 | 401 |
| 只读口令调 `/cmd` | 401（指挥权隔离生效） |
| overview | 14 Agent 全在线（7 入口 + 7 执行） |
| monitor | loadavg、内存 1194MB、alerts 空 |
| 旧 `/cmd` | 七指令不受影响 |

## 7. 已知限制（如实）

1. 明文 HTTP（用户已确认接受）；仅依赖口令强度 + 失败留痕。
2. `/api/events` 与 `/api/tasks/{id}` 会返回任务/事件 payload 摘要，可能含用户私人笔记内容 → 只读口令视同隐私凭据保管。
3. 无分页游标，超大结果集用 limit/offset 截断；知识列表最多 500。
4. Agent 的协作关系暂无可信数据源（协作事件未持久化到独立表），首页连线须等 Phase 5 事件补充，**当前不画协作线**。
