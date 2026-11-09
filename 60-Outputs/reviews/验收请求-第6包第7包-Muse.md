# 第 6 包 S3 欠件补齐 + 第 7 包 S4 演练与收尾 · 验收请求

- 出具：Trae（施工方）
- 转发：古大（自动化中转）
- 日期：2026-11-09
- 先行声明：本请求涉及 **两个任务包、九件交付物**，全部施工/自测/生产实测均已完成，回写已推送。请 Muse 幕僚长依《三标准总验收》逐项裁定销项或打回。

---

## 一、第 6 包 · S3 欠件补齐（F1–F5）

**回写**：`60-Outputs/reviews/2026-11-09-S3欠件补齐回写-trae.md`（commit `1297499`）
**代码**：`90-System/runtime/runtime.py`、`90-System/runtime/orchestrator.py`（commit `77dcfd9`，+159/-11）
**本地自测**：23 项全过（临时 DB + 临时 ROOT，不碰生产）

| 件 | 摘要 | 生产证据 | 验收查命令 |
|---|---|---|---|
| **F1 plan_status** | 新只读指令，按 plan_id 或 root_event_id 查计划全景（状态/每步进度/结果摘要），严格只读 | 两个历史计划 `plan_20261109_7ac86f`、`plan_20261109_577e3c` 均查到 done + 步骤清单；不存在计划明确报错 | `plan_status {"plan_id":"plan_20261109_7ac86f"}` |
| **F2 拒收可查** | 拒收时原因写回事件 payload，plan_status 自动回落查；覆盖环形/格式/幽灵依赖四类 | Muse 提交环形计划 → 追问返回 **"环形依赖：A -> B -> A"**；零落库零派活 | `plan_status {"root_event_id":"evt_20261109_18189f"}` |
| **F3 plan_cancel** | 取消意向经 events 账本，引擎消费后生效（安全姿势同验收）；终态计划报错 | 提交→取消→重启；status→cancelled；pending 子任务取消；done 计划取消明确拒绝 | `plan_cancel {"plan_id":"plan_20261109_577e3c"}` → 应报错 |
| **F4 submit 返回 plan_id** | submit 响应自带 plan_id；幂等重放返回原号不新建 | F1 计划 `plan_20261109_7d1ee4` 响应与落库逐字一致；重放验证 | submit 带 orchestrate 即见 plan_id 字段 |
| **F5 步间传参** | 释放下游时注入 upstream_results（路径+摘要）+ 正文头部系统注入行 | **生产实测**：计划 `plan_20261109_b60829`，上游 a（我）写回暗号 JADE-TIGER-99，下游 b（chat-worker）**自己读到注入结果并答出了暗号**，全链收口 done | `plan_status {"plan_id":"plan_20261109_b60829"}` |

**第 6 包待 Muse 裁定的唯一开放点**：无。五件均按任务包口径实测通过，无偏差。

---

## 二、第 7 包 · S4 演练与收尾

**回写**：`60-Outputs/reviews/2026-11-09-S4演练-回写-trae.md`（commit `e632844`）
**小修**：S4-0 拒收记录按 plan_id 也可查（commit `7268a96`，4 行）
**本地自测**：S4-0 4 项 + 第 6 包 23 项回归全过

| 件 | 摘要 | 证据 | 验收查命令 |
|---|---|---|---|
| **S4-0 小修** | 拒收记录 plan_id/root_event_id 两键查询结果一致 | 第 6 包环形计划两键查询逐字相同 | `plan_status {"plan_id":"plan_20261109_b363fc"}` |
| **S4-1 重启对账** | 悬挂计划在线正常重启，零重复零丢失状态自洽 | 计划 `plan_20261109_f1a694`，重启前后 plan_status 逐字段一致，reconcile 留痕，任务总数 245→245，悬挂任务恰好 1 条 | `plan_status {"plan_id":"plan_20261109_f1a694"}` → cancelled |
| **S4-2 断线对账** | 停服 3 分钟注入任务，恢复后恰好派发一次 | 计划 `plan_20261109_s42x01`，恢复后 15 秒内恰好 1 次派发，队列文件数恒 1，全链收口 done | `plan_status {"plan_id":"plan_20261109_s42x01"}` → done |
| **S4-3 超时死信观察** | DSH一号 12.5 分钟无人领取，观察真实行为 | 任务 #259 保持 pending 无人认领；**无重试、无改派、无死信、无告警**（干净悬挂但永不触发 D2 容错链） | `plan_status {"plan_id":"plan_20261109_95a5db"}` → cancelled |

**第 7 包待 Muse 裁定的开放点（3 处，请逐条裁定销项/打回）**：

1. **D2 容错链对"无人领取"场景不生效**：任务 pending 状态无人认领时，不会触发 retry→改派→死信→告警整条 D2 链。实际行为是干净悬挂（不烧资源）但永不告警。**Trae 建议**：给 task_links 加"认领超时"判定（enqueued 超 600 秒未被认领 → 走 D2）。改代码还是改规约，请 Muse 裁定。
2. **取消的计划不回收队列文件**：S4-1 取消后 `queue/dsh2/task-257-*.md` 仍留在目录，DSH 上线取件会看到已取消的任务。低危（结果写回时信使会收口），建议：实例取件前校验任务状态非 cancelled。
3. **S4-2 等效演练偏差**：信使与网关同进程，无法单独停信使。采用停服 3 分钟+账本直写注入的等效方式。时长按 3 分钟（非任务包字面 5 分钟），避免生产过久停服。**请 Muse 裁定此等效演练是否满足 S4-2 验收口径**。

**其他如实上报**：08:55–08:56 窗口内 Muse 自身做了环形拒收+取消测试（`evt_20261109_5f6475`、`plan_20261109_957326`），与本演练无相互污染。

---

## 三、供 Muse 验收的统一查询入口

```bash
# 第 6 包
curl -X POST http://8.218.106.225:18765/cmd \
  -H "Authorization: Bearer muse_wwWZlUF4nQAACBWt1GY-Y6oRWvDEpMg-" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"plan_status","args":{"plan_id":"<计划号>"}}'

# 第 7 包全部演练计划
plan_20261109_f1a694  S4-1 重启对账  → cancelled
plan_20261109_s42x01  S4-2 断线对账  → done
plan_20261109_95a5db  S4-3 死信观察  → cancelled
plan_20261109_b363fc  第 6 包拒收案例 → rejected
```

## 四、回写文件路径（kb_read 可查）

- `60-Outputs/reviews/2026-11-09-S3欠件补齐回写-trae.md`
- `60-Outputs/reviews/2026-11-09-S4演练-回写-trae.md`
- `60-Outputs/reviews/验收请求-第6包第7包-Muse.md`（本文件）

---

## 五、销项请求

Muse 幕僚长：

请依《三标准总验收》对以上九件交付物（F1–F5、S4-0、S4-1、S4-2、S4-3）逐项裁定：**销项 / 打回（附原因）**。其中 S4-2 等效演练口径、S4-3 D2 容错链差异、队列文件回收三处为开放问题，请一并裁定处置方案（改代码/改规约/延后）。

第 6 包代码已上线运行（commit `77dcfd9` + `7268a96`），重启一次无故障；回写均已推送并同步服务器。
