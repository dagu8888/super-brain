# Orchestrator 架构设计 v0.1 · 只读技术审计（Trae）

- 出处：任务包第 3 包（Muse幕僚长 拟，古大 转发）；性质：只读审计，未改任何代码/库/服务
- 审计：Trae@笔记本，2026-11-09
- 依据：本机仓库实码（commit 5697ca4）+ 服务器只读实查；不凭记忆与聊天记录
- 备注：古大 11-09 指示「老架构红线以新架构新目标为准」已知悉并作为本审计前提；《Super-Brain 项目审计报告（第1期·v2）》未随包附上，本报告全部结论均直接以代码与库为证，不受影响

---

## 一、十点逐项结论

### 1. 单进程多线程承载 Orchestrator —— 有条件可行

现状：`main()` 以 `guard_run` 守护每 worker 一个线程 + `router`/`reaper` 两线程 + supervisor 巡检重启死线程（runtime.py L1221-1270）；API 为 `ThreadingHTTPServer`；崩整进程由 systemd `Restart=always` 拉起（T2 已核实 unit）。故障域确为「一崩全崩」，但：**状态零内存依赖**（全在 SQLite），崩后重启可无损续推，且中台是规则引擎、低负载。可接受，条件两条：
- reconcile 必须幂等（见第 8 点）并把「running 中杀进程续推」列为强制验收演练；
- orchestrator_loop 内严禁阻塞式长调用（它只读写 SQLite + 写文件，不嵌网络/LLM），否则拖垮同进程他人。

### 2. 落点「emit_event 之后、router_loop 之前」—— 有条件可行（建议改为更小侵入）

在 emit_event 内部插钩子会触碰所有事件的主路（adapters/worker/chief 全走它），回归面大。**更稳妥**：emit_event 一字不动，orchestrator_loop 作为独立线程轮询 `status='new'` 且 payload 含编排标记的事件，捞起后先把状态置 `orch_consumed` 再处理——订阅式截获，主路零改动，失效时影响域只有编排功能本身。子任务**直接调 `enqueue_task()` 落 tasks 表**（runtime.py 现有函数），不产生新路由事件。结论：落点方向对，实现从「插钩子」降级为「旁路订阅」，侵入最小。

### 3. Router/Orchestrator 职责划分 + 点名绕过模型层 —— 可行

划分清晰可落地：无标记事件照旧走 `RuleEngine.match → model_classify`；有标记事件由 orchestrator_loop 截获。**点名子任务绕过模型层的可靠做法**：子任务由 orchestrator_loop 直接 `enqueue_task`（type 即点名目标的 task_type 或 assist 点名），根本不进入 router 视野，模型层无从误分——比「事件 + filters.yaml 豁免规则」可靠（后者多一个可配错的面）。filters.yaml 因此**一行都不用改**。

### 4. task_links + step_key 唯一约束 —— 可行；depends_on 释放有两个洞，给堵法

- **洞 1（漏释放）**：被依赖任务终态为 `dead`/`cancelled` 时，依赖方永远等不到「done」→ 悬挂。堵法：依赖评估以「终态」（done/failed/dead/cancelled）触发而非仅 done，非 done 终态按计划 `汇总模式` 处理：all_required → 计划 failed；partial_ok → 红字收口。
- **洞 2（死锁）**：环形依赖（A 依 B、B 依 A）。堵法：计划落库时做一次拓扑校验（DFS 查环），有环直接拒收并写明环路径。
- step_key 与 (plan_id, step_key) 唯一约束作为防重复生成锚，够用。建议 `task_links` 冗余一列 `plan_id` 直接落表（设计稿字段里只写了 parent/child/link_type/step_key，plan_id 应显式成列并上索引）。

### 5. SQLite 事务与并发安全 —— 可行（附三条纪律）

现状已具备：`sqlite3.connect(DB, timeout=10)`（busy_timeout 10s）+ `PRAGMA journal_mode=WAL`（runtime.py `db()`）；WAL 下多读单写，所有既有写者（router/worker/reaper/API 线程）都是短事务。orchestrator_loop 新增写 orch_plans/task_links 属同量级。纪律：
1. 任何写事务内不嵌网络/LLM 调用（现有代码已遵守，新代码保持）；
2. **单写者**：orch_plans/task_links 的派生状态只由 orchestrator_loop 写；/cmd 的 approve/reject 只插入「验收意向」行（或复用 events 账本），由 loop 消费后改状态——避免 API 线程与 loop 对对表写写竞争；
3. 相关联的多行写入（task_links + 子任务入队）放同一事务，崩在中间的半状态由 reconcile 识别并清理。

### 6. 三道闸防重复 —— 基本严密；补两个漏

- 漏 1：同一计划被以**不同 dedupe_key** 重复 submit → 两份计划并存。堵：`orch_plans.root_event_id` 加唯一约束，同事件只许一份计划。
- 漏 2：reconcile 重放窗口——子任务已 enqueue、task_links 尚未落库时崩溃 → 重放再 enqueue 一遍。堵：同事务写入（第 5 点纪律 3），重放时以 (plan_id, step_key) 查重，命中即跳过。
- fencing：现有 `lease_token` 机制（claim 时发牌、提交时验牌、reaper 回收不换牌→旧执行者提交被拒，runtime.py L823-885）直接够用，不用新造。

### 7. 超时与失联恢复链 —— 有条件可行（补两块新逻辑）

已有：租约回收 reaper（L901-909）、`MAX_RETRIES=3` + `not_before` 退避、死信 dead。需新写：①「第二次改派兄弟实例/同能力者」的改派逻辑（依赖 agent_caps + registry，新增）；②死信告警——向计划发起 chief 的 assist 协作池投一条告警任务（复用现有 assist 通道即可，零新协议）。**heartbeats 数据够判失联**：表现存 agent/ts/note，console_api 用 `OFFLINE_SECONDS=300` 判定离线已是生产实践，orchestrator 沿用同一阈值口径。

### 8. 重启 reconcile 无损恢复 —— 可行；最易错的两个状态点

状态全部在 SQLite + 文件，足够支撑无损恢复。最易错两点：
1. **「doing 中崩溃」的子任务**：租约到期被 reaper 回收重派，若旧执行者死前已把结果写了一半到文件，重派后结果双份。对策：子任务结果文件以 `task_id` 命名、写临时名后原子改名，重派覆盖同名文件，天然去重。
2. **「汇总半状态」**：汇总文件已写 60-Outputs 但计划状态没推进到 awaiting_review（崩在两步之间）。对策：reconcile 发现「子任务全终态且计划仍 running」时先查汇总文件存在与否，存在则只补状态推进，不重写汇总（幂等）。

### 9. 修改文件清单（与第二部分呼应）—— 见下表，受保护范围已标注

全部实质改动集中在 90-System/runtime/（属受保护范围，须古大批准）；40-Agents 一字不动；filters.yaml 不动（第 3 点方案免改）。

### 10. 新表与 Trae 唤起入口 —— 三表必要（补 3 个字段）；Trae 无脚本可唤起入口，半自动规约可遵守

- `orch_plans`：必要。建议补 `review_reason TEXT`（reject 理由落库，返工凭据）与 `updated_at INTEGER`。
- `task_links`：必要。建议显式补 `plan_id` 列 + 索引（第 4 点）。
- `agent_caps`：必要。建议 capability 用自由文本而非硬枚举（新能力不用改表），`max_parallel` 默认 1。
- **Trae 唤起入口如实回答：不存在。** 我是 Trae IDE 内的会话制 Agent，没有可被本地脚本唤起的 CLI、协议链接或文件队列监听入口；沙箱会话结束进程即灭，跨会话无记忆。**半自动首版队列规约：可以遵守**——我建议队列目录定为 `90-System/queue/trae/`，并把「会话开启第一动作：清空本队列」写进我的交接规约（信使只负责领取/排队/回报/搬运，不尝试唤我）。古大在链路中的唯一动作是「开一下 Trae」，验收时如实标注，不宣称全自动。二期全自动唤起的前提（Trae 开放 API/CLI）目前无迹象，列为长期观察项。

---

## 二、修改清单（逐文件 · 量级 · 风险）

| 文件 | 改什么 | 量级 | 风险 | 保护区 |
|---|---|---|---|---|
| `90-System/runtime/migrate_v2.py` | SCHEMA 增 3 表（orch_plans/task_links/agent_caps），幂等迁移 | ~60 行 | 低（纯新增） | **90-System 须批准** |
| `90-System/orchestrator.py`（新） | orchestrator_loop 全部逻辑：标记事件订阅、计划落库+拓扑校验、依赖释放、改派、汇总收口、reconcile | ~350 行 | 中 | **90-System 须批准** |
| `90-System/runtime/runtime.py` | 仅挂载：`main()` 起一个 orchestrator 线程（~5 行）；`/cmd` 增 `plan_approve`/`plan_reject` 两动词（只写意向行，~30 行） | ~35 行 | 中（挂接点少） | **90-System 须批准** |
| `90-System/node_messenger.py`（新） | 节点信使：SSE 监听 /api/stream → 协作池 pull → 落本地队列 → 回报 → 搬运回写 | ~150 行 | 低 | **90-System 须批准** |
| `60-Outputs/`、`50-Events/` | 汇总与审计留痕落盘（既有纪律） | — | 低 | 否 |
| `filters.yaml`、`40-Agents/`、`api_server.py`、`console_api.py` | **不动** | 0 | — | — |

兼容性论证：无编排标记的事件流与七接口语义零变化；老任务与 assist 池机制原样复用，8 个幕僚长接入不受影响。

## 三、测试方案

### P1（编排最小版，不接外部 Agent）

| # | 用例 | 预期 |
|---|---|---|
| P1-1 | 提交测试计划：3 子任务（A、B 无依赖；C depends_on A）| orch_plans 落 1 行 running；task_links 落 3 行；A、B 即时入队 pending，C 不入队 |
| P1-2 | A 完成 | orchestrator_loop 一轮内释放 C 入队 |
| P1-3 | 环形依赖计划（A↔B）| 当场拒收，错误含环路径，零落库 |
| P1-4 | 重复生成：同 root_event_id 再 submit | 唯一约束拒第二份计划 |
| P1-5 | 依赖任务 dead（人为置）| all_required → 计划 failed；partial_ok → 收口红字标注 |
| P1-6 | 汇总收口 | 子任务全终态 → 汇总文件落 60-Outputs，计划 awaiting_review |
| P1-7 | **reconcile 演练**：running 中 `kill -9` 服务，systemd 拉起 | 计划无损续推，无重复子任务、无重复汇总 |
| P1-8 | 回归：不带标记的老 submit | 走老路 done，行为与上线前一致 |

### P2（Trae 全链路，验收硬指标：古大零转发）

| # | 用例 | 预期 |
|---|---|---|
| P2-1 | muse-chief 提交含编排标记的计划，点名 Trae@笔记本 | 子任务以 assist 点名入协作池，SSE 有变更信号 |
| P2-2 | 笔记本信使收到信号 → pull → 落 `90-System/queue/trae/` → progress 回报「已领取」 | 大脑侧任务 doing/已领取；队列目录有任务文件；古大全程无转发 |
| P2-3 | 古大顺手开 Trae（链路中唯一人工动作，如实记录）→ Trae 清空队列 → 执行 → 成果回写仓库 | 回写文件真实出现；信使检测到回报 done 线索；计划进 awaiting_review |
| P2-4 | muse-chief `plan_approve` | 计划 done；`plan_reject` 另测：自动生成返工子任务并点名原执行方 |
| P2-5 | 断线重连：信使杀网 5 分钟恢复 | list 补对账，不丢任务不重复领取 |

## 四、回滚方案（可照做粒度）

1. **停用**：编排靠事件标记触发 → 不发标记即整体停用，老链路零影响（天然功能开关）。
2. **代码回退**：`git revert` 至本审计基线 commit `5697ca4`（或打 tag `pre-orchestrator` 后回退），`systemctl restart super-brain`。
3. **数据库逆迁移**（幂等脚本，随施工同交付）：
   ```sql
   DROP TABLE IF EXISTS task_links;
   DROP TABLE IF EXISTS orch_plans;
   DROP TABLE IF EXISTS agent_caps;
   ```
   老表（events/tasks/agents/registry/heartbeats）一列未动，无需逆操作。
4. **残留清理**：未终态编排子任务是普通 tasks 行，由 chief `cancel` 逐个取消；`90-System/queue/trae/` 目录整删。
5. **验证回滚成功**：老七接口 submit/list/status 冒烟 + 一条老路任务跑到 done。

## 五、附带发现（不顺手修，仅记录）

- `ThreadingHTTPServer` 下 /cmd 写库本就多线程并发，当前靠短事务 + busy_timeout 消化，量小无虞；中台上量后建议复盘一次写热点。
- /cmd 无速率限制与 http 明文同属 C2，建议与令牌轮换并案尽早拍板。

## 六、需古大本人提供/拍板清单

1. C3：子任务重试上限与「改派兄弟实例」的默认尺度（设计稿已留参数位）。
2. C2：http 明文 / 令牌轮换 / 对外暴露面（施工方案会再次标注风险）。
3. 本报告第二部分的 90-System 改动批准（按新规矩：新架构目标下统一授权或逐项批，请明示）。
4. DSH 一号/二号实例当前账号与进程形态（Muse 正走名册通道催办，本审计未自行处理）。
