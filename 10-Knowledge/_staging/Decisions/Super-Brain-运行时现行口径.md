---
title: Super-Brain 运行时现行口径（代码里的关键参数与已变更的旧说法）
type: 综合页
layer: 暂存区
status: 草稿
category: Decisions
valid_from: 2026-11-11
source: [90-System/runtime/runtime.py, 90-System/runtime/api_server.py, 90-System/runtime/projects.py, 90-System/runtime/path_guard.py, 90-System/runtime/kb_config.json]
confidence: 文档依据
tags: [运行时, 参数, 现行口径, 事实变更]
---

# Super-Brain 运行时现行口径

> 待审草稿（grok-chief 2026-11-11 从代码逐条核对整理）。以后知识库只检索 Markdown，这些原本只写在代码里的现行事实集中放在这一页。旧口径在别的页面里出现时，以本页为准。

## 任务调度（runtime.py）

- Router 事件轮询间隔：`SCAN_INTERVAL = 10` 秒（2026-11-08 批示#2 由 30 秒提速到 10 秒；“30 秒”是旧口径）。
- 任务租约：`LEASE_SECONDS = 120`（120 秒）；执行中续租间隔 `RENEW_INTERVAL = 30`（30 秒）。
- 任务认领超时：`CLAIM_TIMEOUT = 600`（600 秒，pending 超过仍无人认领 → 进 D2）。
- 认领超时/死信告警：`ALERTS_ENABLED = False`。2026-11-09 告警递归事故（告警任务本身又被认领超时扫描）一夜把死信放大到约 16 万条，止血后告警只记日志、不再自动生成告警任务；超时判定、改派、死信转移仍在。
- inbox-triage 调模型 `max_tokens=8000`（P0 修复前是 3000，旧口径）。
- 最大重试 `MAX_RETRIES = 3`。

## 知识库入口与入库（runtime.py / kb_engine.py / kb_intake.py）

- 网关 `/cmd` 的 kb_search：检索词参数名 `q/text/keyword` 任选其一，三者都空返回「空关键词」；limit 默认 10、上限 20。2026-11-11 起只检索 git 跟踪的 .md，引擎 legacy/hybrid/shadow 由 kb_config.json 切换。
- kb_search / kb_read 过滤的敏感文件：名称以 api_tokens、llm.json、state.db、.env 开头，或后缀 .db / .db-wal / .db-shm / .pem / .key；2026-11-11 起输出还会遮蔽口令、激活码、令牌等字符串。
- 10-Knowledge 的 category 只能是 Concepts / Decisions / Playbooks 三选一。
- 外部纯文本 submit 的笔记：先落 `00-Inbox/.staging/inbox-<hash>.md` → inbox-triage（模型）分类 → **2026-11-11 起先进暂存区 `10-Knowledge/_staging/<category>/` 当草稿并提示大古** → 审批人用 kb_promote 才进 10-Knowledge 编译层（旧口径是直接写入 10-Knowledge/<category>/）。
- chief（含 grok-chief）在 PathGuard 的写白名单为空；正式笔记应写入 00-Inbox，由 knowledge-worker 整理。40-Agents/、90-System/ 为受保护目录，Worker 一律不能写。

## 控制台与网关（api_server.py / projects.py）

- 控制台只读接口 GET /api/*：2026-11-11 起免口令（写入仍走 /cmd 或大古口令）；“需要 viewer 只读口令”是旧口径。
- 大古在操作台做写操作：2026-11-11 起用每日口令（当日口令，当天首次输入，当晚 23:59 前有效），旧配对框输入当日口令也可解锁；“配对码”是旧口径。
- https 正式入口：console.8.218.106.225.nip.io + Let's Encrypt，已验收；“只有明文 HTTP、没有 HTTPS”是旧口径。
- 项目编辑、改阶段、验收的权限：`EDITORS = ("dagu-owner", "grok-chief")`，即大古（dagu-owner）与指挥官 grok-chief，其他 Agent 只读。
- 系统里记录时间一律用北京时间。

## 在线状态

- 2026-11-11 起不再每小时生成「心跳丢失」告警任务和对话页；节点在线⇄离线翻转时给大古推一条提示，同一节点 30 分钟内最多一次。
