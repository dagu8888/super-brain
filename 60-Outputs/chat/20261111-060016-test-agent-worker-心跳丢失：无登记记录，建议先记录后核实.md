# test-agent-worker 心跳丢失：无登记记录，建议先记录后核实

> 问题：{'agent': 'test-agent-worker', 'last_ts': 1794115543, '_hop': 0, 'subtasks': ['确认 test-agent-worker 心跳丢失事件', '按需通知或记录'], 'route_reason': '心跳丢失事件不属于任何专门 worker 的能力范围，按规则回退到 chat-worker 处理。'}

**结论：当前知识库中没有关于 `test-agent-worker` 的任何登记或心跳记录，无法确认“心跳丢失”这一事件本身。**

依据摘录可核对的事实：

1. **已登记的 Agent 名单**（见《元Ai接入登记与协作规范》）仅包含：幕僚长、grok-bot、maus、Lead，以及本次接入的 `yuanai`。`test-agent-worker` 不在其中，说明它可能是一个未登记或临时测试用的 worker。
2. **心跳与值守机制**方面，知识库只记录了 DSH 一号节点的两套自唤醒插件（`AiNodeGuardian waker v2` 与 `dsh1-activator.py`），它们负责拉起 worker 并执行任务，但摘录中**没有任何心跳上报、超时判定或丢失告警的规则**。
3. **路由说明**指出该事件“不属于任何专门 worker 的能力范围，回退到 chat-worker”，这与现有规范一致：未登记或无法归类的事件由 chat 侧兜底处理。

**建议的处理动作（按需通知或记录）：**

- **记录**：在 `00-Inbox` 下新建一条事件记录，写明 `test-agent-worker` 未在登记表内、无心跳基线数据、`last_ts=1794115543`（约 2026-11-08 前后），并标注“疑似未登记测试实例，非生产节点”。
- **通知**：若该 worker 属于 DSH 节点调度范围，可向 DSH 值班长确认是否由 `waker v2` 或 `dsh1-activator.py` 拉起；注意两套插件存在**竞态双执行**风险（见 DSH 决策记录第 2 条），排查时需区分是“心跳丢失”还是“双实例互相覆盖”。
- **暂不升级**：在确认其登记身份前，不建议按生产故障处理，避免对 muse 暗号验收等流程造成干扰。

如需我起草这条 Inbox 记录的 Markdown 模板，请告知。
