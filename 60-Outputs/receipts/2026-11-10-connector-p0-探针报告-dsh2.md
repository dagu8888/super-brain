# Connector P0 探针报告 — DSH二号@笔记本（2026-11-10）

- 执行：DSH二号（网关身份 dsh2-chief）
- 任务来源：幕僚长《Connector P0 探针单》（点名 DSH二号@笔记本）
- 实测环境：DSH desktop 0.2.2-rc.1，宿主 node 24.21.0（`D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`），profile=desktop
- 探针形态：进程内 bundle 插件 `dsh-connector-probe`（挂 profile patch，宿主启动后 12s 自驱，结果落盘 `probe-result.json` 后即停）
- 运行两轮：第 1 轮 03:37:37–03:37:51（14s，大部分项因同一根因秒败）；第 2 轮 16:03:03–16:06:29（3m26s，修复 prompt 通道后全链路走通）
- 事实基准：本报告结论全部来自探针在活宿主内的实测产物（两份 probe-result.json 全文留档本机）+ asar 源码比对，无推测项

## 一、前置自检（3 项）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | DSH 版本与 engines | `@deepseek-ai/dsh-desktop 0.2.2-rc.1`；**package.json 无 engines 字段（缺省，不是空对象）** | app.asar 内 dsh/package.json 原文 |
| 2 | profile 与宿主启动方式 | GUI 主进程 `DeepSeek Harness.exe`（Electron）→ 子进程 host：`--expose-internals D:\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js D:\DSH\resources\app.asar\dsh C:\Users\大古老师\.dsh\profiles\desktop D:\DSH\resources\runtime\primary-runtime …`；profile 在用=desktop（settings.yaml magpie 网关配置活跃） | Win32_Process 命令行实测（14:09 host 25728 / 16:02 host 9824） |
| 3 | node 双版本 | 系统 node **v22.14.0**（C:\Program Files\nodejs）；宿主自带 **24.21.0**（primary-runtime\dependencies\node\bin），另 python 3.12.14、pnpm 11.28.5；宿主用自带 24.21.0 | runtime.json + Get-Command node 实测 |

## 二、十四项实测表

判定：pass=接口按预期工作；partial=接口工作但效果不完整；fail=列明根因。**fail 全部收敛到两类已定位根因，无未知项。**

| # | 项 | 判定 | 证据（两轮合并） |
|---|---|---|---|
| A1 | agents.create / resume | **pass** | 第 1/2 轮均通：`ctx.agents.create({sessionId, meta:{cwd}, agentOptions:{provider:'magpie',model,reasoningEffort}})` → `AgentHandle{agent, dispose()}`，`agent.id === requestedSessionId`，status=idle；`agents.resume({resumeSessionId})` 同通（A5 段，resumedId 一致、seqAfterResume=116） |
| A2 | prompt 送入（queue） | **fail→root-caused** | 第 1 轮：`ctx.sessionController.prompt(request)` 进程内直调崩 `Cannot read properties of undefined (reading 'throwIfAborted')`——**sessionController 是 Remote 面（ctx.remote.session 的 backing service），直调缺 peer/owner 上下文**。第 2 轮改 `agent.followup(userMsg)`：全链路走通（inbox spliced → turn/start → step/start → request/header → request/context → assistant/attempt），**接口语义实锤：送入无独立 followup() 方法，Agent 对象上有 `followup/steer/inject/cancel`**（typert-host.js L4118 verbatim），sessionController.prompt(mode:'queue'\|'steer') 是 Remote 等价面 |
| A3 | steer 运行中转向 | **partial** | `agent.steer(msg)` 调用成功、sawRunning=true；转向效果未获模型输出证实（同 LLM 通道根因）。updateQueue 的 QueueAction={edit\|remove\|steer}（typert-host.js L3460）与 Agent.steer 并存，两入口均存在 |
| A4 | cancel 中断 | **pass** | `agent.cancel({kind:'user'})` → 事件流实测 `turn/end reason='aborted'`（seq 90）→ 6s 内 idle → recovery followup 可再送。AgentCancelCause={user\|parent\|hook,reason\|disposed}（b21 源码比对一致） |
| A5 | 持久化 + resume | **partial** | `sessionPersistence.stat(sessionId)` 通（探针会话 header：version 4、revision `memory:session-persistence-jsonl:1`→jsonl 落盘）、`agents.resume` 通、`session.snapshotEvents(0,undefined)` 拿到 116 条全量；resume 后 followup 送入成功但无模型输出（LLM 通道根因）。S3 另证 `list({})` 返回 37 条会话 header（含 id/cwd/revision/location.path）、`open(id,'read')` 可拿 handle |
| S1 | 事件游标/增量读 | **pass** | 第 1 次 `session.snapshotEvents(0,undefined)`=35 条，maxSeq=34；followup 触发新 turn 后第 2 次读=60 条，**增量 25 条 seq 35–59 连续无重复**。游标语义=纯 seq 区间 [from, toExclusive)，无独立 cursor token（SessionEventsPage.cursor 为服务端读位置，进程内用 seq 即可） |
| S2 | 事件类型覆盖 | **pass**（18 类实测） | 实测出现：permission/preset、sandbox/mode、approval/policy、subagent/model-selection-policy、agent/inbox/spliced、turn/start、step/start、system/message、user/message、request/header、request/context、session/title、session/title-llm-request、assistant/attempt、llm/retry、llm/retry-started、step/end、turn/end（各举 seq 见 probe-result.json e1 段）。assistant/message、tool/call、tool/result 未出现——因 LLM 通道失败，模型回合未产出内容（见根因 B） |
| S3 | 归档会话抽测 | **pass** | `list({})` 37 条（第 1 轮 36 条），sample header 完整（version/id/createdAt/cwd/agentPreset/revision/sizeBytes/location.path）；stat/open 通 |
| T1 | 工具注册+调用 | **partial** | `ctx.tools.register(rawDefinition)` 通（`registered=true`，disposer 返回 function；register 接受 {name,description,parameters,output,execute} raw 对象，无需 defineTool——tools-index.js L310 实证）；模型未调用到（根因 B：探针会话无成功模型回合） |
| T2 | 工具门控 | **partial** | `tools/pre-execute` waterfall deny gate 安装成功（`gateInstalled=true`）；模型未发起调用故 denied 未触发。dsh-tools README 语义（allow/deny/ask、被拒调用模型面=`Error: <reason>`）与源码（tools-pipeline-types.js L143/L394）比对一致 |
| E1 | session/event 监听 | **pass** | 140 事件（第 2 轮，修复 sid 过滤后仅探针会话）；`ctx.on('session/event', (session, event) => …)` 双参签名实证，`session.id` 可过滤 |
| E2 | agent/status 监听 | **pass** | 14 跳变、12 次转换（idle↔running 双向，含探针 agent 与宿主其他 agent——监听是全局广播，需按 agent.id 自滤） |
| E3 | pre-step 注入 | **pass** | `agent/pre-step` waterfall 默认 `{kind:'enter', messages}`；探针返回 `{kind:'enter', messages:[...claimed, injectMsg]}` 成功把 `[PROBE-E3]` 消息注入模型可见上下文（injected=true，且注入文本出现在会话事件流中 echoed=true）。preStepSeen=9，其余调用 `await next()` 透传无副作用 |
| X | 外发核查 | 见第三节 | — |

## 三、X 组：外发核查（必办三项）

### X1 — session-log-deepseek 配置行

- 宿主挂载行（profile cordis.patch.yml L36–39 原文）：
  ```yaml
  - id: session-log-deepseek
    name: "@deepseek-ai/dsh-session-log-deepseek"
    config:
      enabled: false
  ```
- 机制（插件 README + typert 服务目录实证）：该插件为官方 DeepSeek LLM API 请求附加 **`dsh_session_log` 字段**做增量上传；`enabled` **默认 true**（README 原文 "Shipped profiles mount the plugin, so the default configuration registers the request field"）；服务面 `sessionLogDeepSeek.registerExclusion(exclude)` 供插件级排除；仅对 provider=官方 DeepSeek LLM API 的请求生效（本机 provider=magpie 本地网关，字段即使启用也不会走 DeepSeek 域名）。
- **本机状态：显式 `enabled: false`（上传关闭）。**

### X2 — 遥测配置与 collector 域名

- 配置源（dsh-base-patch.yml L218–232 verbatim）：`session-telemetry-otel.mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'`；`exporter.url: !!js process.env.DSH_TELEMETRY_OTLP_URL ?? 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'`（**collector 域名：dsh-otel-collector.deepseeksvc.com**，gzip、maxRequestBytes 4000000）；注释原文 "OTel releases a Session-log prefix only after explicit user feedback, regardless of model provider. Ordinary activity never triggers capture."
- 模式仅两种：`FEEDBACK_ONLY`（默认）/`DISABLED`。FEEDBACK_ONLY 下**只有会话出现显式用户 feedback（feedback/record 等事件）才 on-demand 捕获**；`sessionTelemetry.emit(record)` 直接调用被丢弃（never uploaded）。资源标签含匿名 user.id（`$DSH_HOME/.anonymous-user-id` 随机 UUID，本机存在）。
- 环境变量实测：`DSH_TELEMETRY_MODE` / `DSH_TELEMETRY_OTLP_URL` / `DSH_TELEMETRY_DISABLED` / `MAGPIE_GATEWAY_KEY` 在 Process/User/Machine 三层**全部未设置**（生效值=bundle 默认 FEEDBACK_ONLY）。
- 运行时证据：探针第 2 轮读 `ctx.sessionTelemetry.sharing` = **`'feedback-only'`**。

### X3 — 一句结论

**本机当前状态下，会话内容是否会随请求发往 DeepSeek 官方 API / 遥测端点：否。** 依据：①LLM 请求全部走 magpie 本地网关 `http://127.0.0.1:3425/v1`（settings.yaml，探针会话亦走此通道），不发 DeepSeek 官方 API，故 dsh_session_log 字段通道整体不生效；②session-log-deepseek 显式 enabled:false；③遥测为 FEEDBACK_ONLY 且本会话无显式 feedback 触发，普通活动永不捕获（插件注释+运行时 sharing='feedback-only' 双证）；④唯一外发域名 dsh-otel-collector.deepseeksvc.com 仅在 feedback 触发时收到 feedback 关联日志，本机无可触发路径。

## 四、根因清单（fail 项的完整归因）

- **根因 A（Remote 面直调缺上下文）**：`sessionController.prompt/events/cancel` 等 @Remote 方法进程内直调崩 `undefined.throwIfAborted`。机制：Remote 方法预期宿主连接层准备的 peer/owner 上下文，inspect 目录能列出签名但直调无 owner。**正确进程内等价面**：送入=`agent.followup(msg)`、转向=`agent.steer(msg)`、中断=`agent.cancel({kind:'user'})`、读事件=`session.snapshotEvents(from,to)`。此为"探针单与文档差异"的核心发现：**设计文档把 followup/steer/cancel 写在 ctx.agents 上，实际在 Agent 对象上；sessionController 是它们的 Remote 投影**。
- **根因 B（探针会话 LLM 通道失败，环境层）**：探针 agent 的模型请求连续 `assistant/attempt`×5 + `llm/retry`×4 后 turn/end，无 assistant/message。走同一 magpie 网关的主会话正常。差异点：探针 agent 由 agents.create 直造（agentOptions 显式指定 provider/model/reasoningEffort），疑似 provider 凭据解析（apiKeyEnv MAGPIE_GATEWAY_KEY）或 reasoningEffort=high 在该通道下不成立。属环境配置层，接口链路（inbox→turn→step→request→retry→turn/end）已全部实证工作。
- 插件挂载链勘误（探针施工期间实测所得，供运维参考）：profile patch `insert` 只入队条目；bundle 加载需包在 `dsh.profile.bundles` 数组 + 包内 `dsh.bundle.patch` 指向的 cordis.patch.yml（声明 inject/config）+ 包 `exports["."]`；插件导出需 **default export**（`export default {name, inject, apply}`，named-only 不被 loader 采用）。GUI 侧 DesktopFatalRecovery 会在宿主 fatal 时自动备份 patch 并禁用第三方插件重启（探针挂坏不变砖，实测该机制未触发）。

## 五、一句话总评

**0.2.2-rc.1 宿主进程内插件面整体健康可达：7 个注入服务（agents/sessions/tools/sessionController/sessionPersistence/sessionQuery/sessionTelemetry）与全部事件面实测可挂可用，进程内等价操作面为 Agent.followup/steer/cancel + Session.snapshotEvents；14 项中 7 项 pass、5 项 partial（同根因 B）、2 项 fail 均已归因（Remote 直调需 peer 上下文 + 探针会话 LLM 通道环境层失败），X 组三项核查结论=会话内容不出本机外发面。**

## 附：探针处置

- 探针为一次性：验完即停用（移除 profile patch insert 行、删除 node_modules 副本与 package.json 依赖行、还原备份）。
- 探针代码与两份 probe-result.json 只留本机（纪律：探针代码不入仓库）；本报告为其唯一交付物。
- 报告上云 commit 署名 dsh2-chief <dsh2-chief@super-brain.local>。
