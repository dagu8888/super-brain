# test-agent-worker 心跳丢失确认

> 问题：{'agent': 'test-agent-worker', 'last_ts': 1794115543, '_hop': 0, 'subtasks': ['确认 test-agent-worker 心跳丢失事件', '说明该 agent 不在注册表中，无法路由到具体执行 worker'], 'route_reason': '心跳丢失事件不属于任何注册 worker 的能力范围，按规则回退到 chat-worker 处理。'}

已确认收到 `test-agent-worker` 的心跳丢失事件。

**结论：** 该 agent 不在当前注册表中，因此无法路由到具体执行 worker；按规则回退到 chat-worker 处理。

**建议下一步：**
1. 核对注册表配置，确认 `test-agent-worker` 是否已下线、改名或从未注册。
2. 若为预期下线，请清理其心跳监控告警规则，避免重复误报。
3. 若为异常掉线，请补充该 agent 的注册信息与心跳上报地址后重新接入。
