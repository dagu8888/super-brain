# 任务 #285 设计说明 — 值班室施工：自唤醒执行插件（DSH二号@笔记本）

- 任务：#285（点名 dsh2-chief，古大拍板预授权）
- 写此说明时间：2026-11-09 18:49（动手施工前回写，按任务要求"先回写简短设计说明再动手"）
- 事实基准：super-brain @ 414fc3d

## 一、启动入口侦查结论（已实测）

DSH 桌面端（D:\DSH\DeepSeek Harness.exe，Electron dsh-desktop v0.2.2-rc.1）**没有**"带 prompt 启动新会话"的 CLI/深链入口：

- 命令行参数仅识别 `--updated`（main.js L20311）；second-instance 只聚焦已有窗口（L15245）；
- 深链仅支持 `dsh://open` → 聚焦主窗口（L21328-21331）；
- 桌面壳无自建 HTTP 服务（GUI 端口 61878 由 DSH runtime 提供，API 需 GUI 登录态鉴权，插件无法取得）。

**DSH 原生可用的程序化入口是它的调度任务机制**：DSH 会话可创建定时调度任务，到点由 DSH runtime 自动把一条 prompt 作为用户消息投递进目标会话，会话即自动开工——这就是"程序化拉起干活实例"的官方机制，全程零用户输入、零 hack。

## 二、双层架构设计

**发现层（插件脚本，dsh2-waker.py，零 LLM、零轮询）**：

1. 与 dsh2-courier.py 同一套 SSE 长连（`GET /api/stream?instance=DSH二号@笔记本`，指数退避 5→300s），凭据共用环境变量 SB_VIEWER_TOKEN；
2. 变更信号到达 → `GET /api/tasks` 过滤 `status=pending & type=assist & to_agent=dsh2-chief`；
3. 每个新任务先 `GET /api/tasks/<id>` 复核状态（**cancelled/非 pending 一律不投递**——吸取 #257 悬挂任务教训）；
4. 幂等写待办文件 `D:\DSH\AIOS-V4.0\_duty\todo\task-<id>.todo`（内容=任务号/标题/正文/创建时间/复核状态），已存在 .todo/.claimed/.done 则跳过；
5. 本插件**只发现、只落盘**：不执行任务、不调 LLM、不碰任务状态、不碰 90-System/runtime/、不碰 trae 队列。

**执行层（DSH 原生调度=干活实例的拉起方式）**：

- 由 DSH二号当前会话创建一条常驻调度任务（target=this_session，每 20 分钟）：DSH runtime 到点自动向本会话投递"值班巡查"prompt → 会话读取 `_duty\todo\` 下的 .todo 文件 → 经网关二次验状态 → 原子改名为 .claimed（防跑两次）→ 执行任务 → 按 queue README 写 `90-System/queue/dsh2/results/task-<id>-结果.md` → git add -f 上云（收口锚点）→ 改名 .done。
- 任务出现到开始执行的时效 ≤20 分钟（调度周期）；发现层落盘为秒级。

## 三、防重复 / 防跑两次

- 插件侧幂等：.todo/.claimed/.done 三态文件名判定，同一任务只落盘一次；
- 执行侧原子领取：巡查先 rename .todo→.claimed 再干活，并发/重复唤醒只会有一个领取者；
- 验状态双保险：插件落盘前验一次（cancelled 不落盘），巡查领取前经网关再验一次（cancelled 不执行）。

## 四、常驻与自愈

- dsh2-waker-start.bat 启动器（无凭据不进重启循环，与修订版 courier 启动器同式）；
- 自启注册：HKCU Run 项 `dsh2-waker` + Startup 快捷方式，双通道与 courier 一致；
- 断线自愈沿用 courier 的指数退避；DSH 调度任务由 DSH runtime 自管，随 DSH 常驻。

## 五、纪律确认

凭据只走环境变量（不写文件/回执/日志）；零 LLM、零高频轮询（SSE 推送 + 20 分钟值班巡查为 DSH 原生调度，非脚本轮询）；只动本节点队列与 `_duty\` 待办区；不动服务器 runtime、trae 信使与队列、MAUS二号。

署名：DSH二号@笔记本（dsh2-chief）｜ 2026-11-09
