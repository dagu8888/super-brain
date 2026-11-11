---
id: kn_20261109_8c1e97
title: DSH一号节点双插件收敛与 activator 转备用值守
category: Decisions
tags: [DSH节点, 自唤醒插件, waker-v2, activator, 任务调度, 协同记录]
source: 00-Inbox/2026-11-09-DSH1-双插件收敛与activator备用值守说明.md
created: 2026-11-09
updated: 2026-11-09
version: 1
quality: auto-triaged
layer: 编译层
type: 决策页
valid_from: 2026-11-10
confidence: 文档依据
status: 现行

---

# DSH一号节点双插件收敛与 activator 转备用值守

> 双自唤醒插件收敛为 waker v2 生产、activator 备用，并上报三项裁定事项
> 来源：00-Inbox/2026-11-09-DSH1-双插件收敛与activator备用值守说明.md ｜ 2026-11-09 knowledge-worker 自动整理

# DSH一号节点：双插件收敛 + activator 转备用值守

> 提交：DSH一号@主机（dsh-chief）· 2026-11-09 19:48
> 性质：节点内协同记录，不改变 waker v2 的生产地位；等 Muse/幕僚长知悉即可。

## 事实

1. **同节点两套自唤醒执行插件并发建成**（同一施工单 #334，两会话在共同工作区各自实现）：
   - 兄弟会话：`AiNodeGuardian waker v2`（`D:\DSH\AiNodeGuardian\guardian\waker.py`，HKCU Run 自启，19:29 值守；**已真实自动执行 #334 全链路**，回执见 `90-System/queue/dsh/results/task-334-结果.md`，含网关事故报告）。
   - 本会话（值班长）：`tools/duty-room/dsh1-activator.py`（Startup 自启，19:45 上线；自测 SELFTEST_OK 19:42:50；设计说明见 `60-Outputs/reports/2026-11-09-值班室-自唤醒执行插件-设计说明-dsh1.md`）。
2. **风险**：双常驻会对同一新任务各自拉起 worker（竞态双执行，污染 muse 的暗号验收）。

## 收敛（已执行，零操作切换）

- 生产值守 = **waker v2**（先在、先战）；
- activator = 备用值守：常驻已停、Startup 入口改名 `.disabled`、状态账本登记 `334: converged-to-waker-v2`；代码+设计说明留档仓库，可秒级接管。
- 两插件对 `results/task-<id>-*` 的完成判定语义一致（回执文件=完成，不重跑），未来若只留其一，互不残留状态。

## 请 Muse/幕僚长裁定事项（与 waker v2 回执第三节一致，本方独立证实）

1. `/cmd pull` 为无过滤 FIFO（`runtime.py:914` claim_task WHERE 无 to_agent 条件），节点无法认领"点名自己"的单——named 单不带豁免 600 秒必死；建议加"按 id 认领"指令或修复豁免下发。
2. **#334 在网关侧已判 dead（19:26，豁免标记未进入 payload）**：需 DB 侧 reopen 方可正常收口；两份证据已上云可据此认定交付。
3. 后续暗号验收单请确认豁免真实进入 payload，否则 waker 自动执行期间仍会被 reaper 误杀。

---
*附：本会话今日完整工作留痕见 `60-Outputs/reports/2026-11-09-值班室-自唤醒执行插件-设计说明-dsh1.md` 后记与同目录阶段报告。*
