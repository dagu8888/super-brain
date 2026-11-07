# 40-Agents 配置区（配置即代码）

Super-agent 的全部运行配置放在这里，纳入版本管理，改动即审计。

规划中的文件（第三步生成）：

```
40-Agents/
├── router/
│   ├── router.yaml       # Router：人设、轻量模型、路由规则、回复约束
│   └── filters.yaml      # 事件快过滤规则（DROP / ALLOW / URGENT）
├── workers/
│   ├── knowledge-worker.yaml   # 知识整理与回写
│   ├── code-worker.yaml        # 代码评审 / CI
│   └── chat-worker.yaml        # 群聊对话 / 研究
└── watchdog.yaml         # 看门狗：巡检频率、健康阈值、告警渠道
```
