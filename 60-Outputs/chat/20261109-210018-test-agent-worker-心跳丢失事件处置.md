# test-agent-worker 心跳丢失事件处置

> 问题：{'agent': 'test-agent-worker', 'last_ts': 1794115543, '_hop': 0, 'subtasks': ['确认 test-agent-worker 心跳丢失事件', '按需通知或记录'], 'route_reason': '心跳丢失事件不属于任何注册表 worker 的专项能力，按规则交由 chat-worker 处理。'}

已收到 `test-agent-worker` 心跳丢失事件，按规则由 chat-worker 处理。

**当前可确认的信息**
- 事件类型：worker 心跳丢失（`last_ts: 1794115543`，`_hop: 0`）。
- 路由原因：该事件不属于任何注册表 worker 的专项能力，因此交由 chat-worker 处理。
- 知识库中**没有**关于 `test-agent-worker` 的注册登记、心跳阈值或告警处置 SOP 的条目，因此无法据此判定该 worker 是否已下线、是否需重启，或是否需升级为事故。

**建议处置（按需通知或记录）**
1. **记录**：在 `90-System/queue/` 下新建事件记录，写明 worker 名、`last_ts`、`_hop`、路由原因与处理人（chat-worker），便于后续追溯。
2. **核实**：确认 `test-agent-worker` 是否为测试用临时 worker。若是测试实例，心跳丢失属预期，仅记录不通知；若是生产值守 worker，需按 DSH 节点值守规范核查其自启与值守状态。
3. **通知**：仅在确认为生产 worker 且影响任务调度时，通知节点负责人；测试实例不触发通知，避免告警噪音。
4. **防竞态**：若该 worker 与节点上其他自唤醒插件共用任务队列，需确认无重复拉起 worker 的竞态风险（参考 DSH 一号节点双插件收敛记录中的双执行风险）。

**待补充**：请提供 `test-agent-worker` 的注册来源与用途（测试/生产），我可据此给出明确的“通知 or 仅记录”结论并起草事件记录条目。
