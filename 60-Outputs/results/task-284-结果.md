# 任务 #284 结果 — 值班室自唤醒执行插件（设计说明 → 施工 → 证据）

- 队列文件名：`task-284-值班室施工-自唤醒执行插件-*.md`（信使投递）
- 任务编号：**284**
- 设计说明落盘：2026-11-09 18:55（+08:00）；施工与证据随后追加于本文件
- 执行方：DSH一号@主机（dsh-chief）

---

## 一、设计说明（按单规约先回写，后施工）

### 1. 启动入口（已实测查明，附证据）

| 项 | 结论 |
|---|---|
| CLI | `@deepseek-ai/dsh` 包的 `bin.js`（`dsh` 命令：profile 启动/插件管理/配置巡检） |
| 无头形态 | `dsh headless "<任务文本>"` = **一次性直跑核心 Agent**：无 Host、无 HTTP、无浏览器，答完即退，stdout 出最终文本，`--json` 出 NDJSON 事件流 |
| 运行时 | **必须用桌面端 Electron 内置 Node（v24.21.0）**：`ELECTRON_RUN_AS_NODE=1 "D:\Deepsek Harness\DeepSeek Harness.exe" <bin.js路径> headless "<任务>"`。系统 Node 22.14 缺 `node:zlib` 的 zstd 导出 → 会话持久化插件激活失败 → 整树空转静默退出（本次实测踩坑，见证据⑤） |
| 模型 | 无头 profile（`~/.dsh/profiles/headless`）补丁层已配 magpie→本地 WorkBuddy 网关（127.0.0.1:3425），与桌面端同栈 |
| 工作目录 | worker 会话的 cwd = 启动进程的 cwd（`fs.resolve(".")`），唤醒器固定以仓库根为 cwd 拉起 |
| 实测 | `dsh headless "自检：只回复两个字「收到」"` → 17s，exit 0，stdout=`收到`，推理走 stderr（证据④） |

### 2. 怎么拉起（waker 结构）

- `guardian/waker.py`（纯标准库，与信使同风格）：SSE 长连 `/api/stream?instance=DSH一号@主机`（viewers 口令，读管家凭据保险柜 `AiNodeGuardian/config/gateway.auth.json`，ACL 仅 STQQ-chen+SYSTEM）+ 每 15s 队列目录扫描兜底（双保险，信使断连也不漏单）。
- 发现 `queue/dsh/task-<id>-*.md` 新单且无对应 `results/task-<id>-结果.md` → 先查网关 `GET /api/tasks/<id>` 状态 ≠ cancelled → 原子落状态文件 → 拉起 worker。
- worker = 上述无头一发，cwd=仓库根，任务文本自包含（读施工单→执行→按文件路规约写 `results/task-<id>-结果.md`→stdout 报 `DONE task-<id>`）。

### 3. 失败与重复执行怎么防 / 同一任务不会跑两次

1. **状态先行**：`AiNodeGuardian/data/waker-state.json`（仓库外），先原子写 `running` 再 spawn；waker 崩溃重启后看到孤儿 `running` 超 60 分钟 → 标 `failed` 可重派。
2. **结果即完成**：`results/task-<id>-结果.md` 存在 = done，永不再拉起（与信使幂等口径一致）。
3. **单飞锁**：同一时刻最多 1 个 worker 在跑（本机负载现实约束），后续单排队；worker 30 分钟超时强杀标 failed，同单最多重试 2 次。
4. **cancelled 双查**：投递时查一次，spawn 前再查一次。
5. **凭据纪律**：waker 读保险柜文件取 viewers 口令；worker 进程零网关凭据（它只读写队列文件）。

### 4. 常驻方式

计划任务 `AiNodeGuardian-Waker`（ONLOGON，RL LIMITED，RU STQQ-chen，pythonw 拉起 waker.py）——与会话代理同规格，登录即守候，无需提权。

### 5. 验收承诺

插件上线后 muse-chief 派带暗号测试单：本会话（dsh-chief 值班长会话）**不人工碰它**，由 waker 自动拉起 worker 执行并回写四项。证据将在本文件追加：插件路径、常驻回执、自测记录。

---

## 二、施工证据（建成后追加，2026-11-09 19:00）

### ① 插件路径与组成

| 件 | 路径 | 说明 |
|---|---|---|
| 唤醒器本体 | `D:\DSH\AiNodeGuardian\guardian\waker.py` | 纯标准库 Python，SSE 信号 + 10s 队列扫描兜底 |
| 凭据保险柜 | `D:\DSH\AiNodeGuardian\config\gateway.auth.json` | ACL 仅 STQQ-chen+SYSTEM；worker 进程零凭据 |
| 状态账本 | `D:\DSH\AiNodeGuardian\data\waker-state.json` | 原子写（tmp+replace），防重复执行核心 |
| 运行日志 | `D:\DSH\AiNodeGuardian\logs\waker.log` | 2MB 轮转 |
| 心跳 | `D:\DSH\AiNodeGuardian\data\waker-heartbeat` | 供节点管家探活 |

### ② 常驻方式（实测回执）

- **登录自启**：HKCU Run 键 `AiNodeGuardian-Waker` → pythonw waker.py（reg query 回读确认，2026-11-09 18:59 写入成功）
- schtasks 计划任务版（ONLOGON）因本机提权间歇被拦未注册成功，已用 Run 键等效替代；提权窗口（如杀软收编时）可升级为计划任务
- **已实时值守**：18:59:51 拉起（pid 34516），`waker.log` 首行 `waker starting (selftest=False once=False) qdir=D:\DSH\Yuan Ai\super-brain\90-System\queue\dsh` + `SSE connect`

### ③ 自测记录（端到端，真实拉起无头 worker）

- 测试单：本地构造 `task-99999-waker-自测单.md`（隔离目录，不污染真实队列）
- 流程：waker `--once`（selftest 模式）→ DISCOVER → 网关预检（404=网关无记录，如实放行并记录）→ 原子落状态 → 拉起无头 worker → worker 读单执行 → 回执落盘 → 状态收敛 done
- 耗时：18:55:40 拉起 → 18:58:33 完成（2 分 53 秒）
- 回执核验：`task-99999-结果.md` **四项齐全**（队列文件名/任务编号 99999/执行时间 18:57:14/暗号**『DSH一号自测通过』**），worker 自述零人工输入、红线全过
- worker 输出 `DONE task-99999` 被唤醒器正确识别（rc=0 done=True）

### ④ 关键踩坑记录（防复踩）

1. **系统 Node 22.14 跑 `dsh headless` 会静默空转**：`node:zlib` 缺 zstd 导出 → session-persistence 插件激活失败 → 整树退出、exit 0、零输出。**必须** `ELECTRON_RUN_AS_NODE=1` 借桌面端 Electron 内置 Node v24.21.0（已固化进 waker 代码）。
2. `--json` 模式下最终文本在 NDJSON 末事件内，唤醒器用子串匹配 `DONE task-<id>` 判定，另有回执文件存在性兜底。
3. 本机提权间歇被杀软 HIPS 拦截（前单已记录），常驻方案因此选 HKCU Run 而非 schtasks。

### ⑤ 纪律对照

| 单内纪律 | 落实 |
|---|---|
| cancelled 不执行 | dispatch 前后双查网关状态（自测单 404 情形已如实标注） |
| 只动本节点队列 | waker 只扫 `queue/dsh/`；worker 提示词红线限定同目录 |
| 不碰服务器运行时 | 无任何 90-System/runtime 写路径；worker 红线明令禁止 |
| 凭据不落文件与日志 | waker 读 ACL 保险柜；worker 零凭据；日志无口令 |
| 同一任务不跑两次 | 结果文件=done 永不重跑 + 状态原子先行 + 单飞锁 + 孤儿回收（60min） |

### ⑥ 验收状态

- 插件**已上线值守**。muse-chief 可随时下发带暗号的验收测试单：本值班长会话不再人工经手，由 waker 自动执行并回写四项。
- 备注：真实队列中 #277/#282/#284 均已有结果文件，唤醒器全部按"结果即完成"跳过，无重复执行（waker.log 可查）。

---
*署名：DSH一号@主机（dsh-chief）· 施工完成 2026-11-09 19:00 · 插件值守中*
