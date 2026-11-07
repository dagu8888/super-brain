# AGENTS.md — AI Agent 接入与强制同步规范（合同级，违反即回滚）

本文件是所有 AI Agent（lead / DSH 各插件 / CodeBuddy 子代理 / 任何外部 Agent）操作本知识库的**强制合同**。开工前必读本文件。

## 1. 权限矩阵

| 主体 | 读 | 写 | 通道 |
|---|---|---|---|
| lead（Team Lead / DSH 主会话） | ✅ | ✅ | 本地工作副本 + `scripts/*` |
| DSH 各插件（记忆、技能等） | ✅ | ✅（必须经 `writeback.ps1`） | 本地工作副本 |
| CodeBuddy CLI 子代理 | ✅（只读） | ⚠️ 一律转交 lead 代写 | `codebuddy_ask permission_mode=plan` |
| 外部 Agent（手机 / 其它机器） | ✅ | ✅ | GitHub Contents API，见 [[99-Meta/Agent接入示例]] |

**凭据**：本机统一走 Windows 凭据管理器（git credential manager）。禁止把 token 写进任何文件、笔记、脚本、日志。

## 2. 强制同步规则

1. **读之前先拉**：任何读操作前必须 `pwsh scripts/sync.ps1 -PullOnly`（或确认 5 分钟内已 pull 成功）。只读云端 `origin/main`，不读本地陈旧缓存。
2. **写之后必须推**：所有写操作只允许通过 `scripts/writeback.ps1` 或 `scripts/new-note.ps1`，脚本自动完成 commit → `pull --rebase` → push。推完核对输出 `PUSH=OK`。
3. **本地只留工作副本**：禁止在本仓库之外独立存储任何知识库核心内容；临时产物必须回写到 `00-Inbox` 并同步。
4. **冲突以云端为准**：`sync.ps1` 内置 `pull --rebase`，冲突自动取云端版本，冲突记录追加到 `99-Meta/冲突日志.md`。
5. **云端 > 本地**：本地与云端不一致时以 `origin/main` 为准；本地差异只能作为**新提交**叠加在云端之上，禁止覆盖、禁止强推。
6. **云端不通 = 不落盘**：push 失败时用 `writeback.ps1 -NoSync` 暂存本地，恢复后立即重跑同步。

## 3. Agent 标准工作流

```powershell
# ① 开工：拉最新
pwsh "D:\DSH\Yuan Ai\super-brain\scripts\sync.ps1" -PullOnly

# ② 读：直接读本地工作副本（刚拉过 = 云端最新）
Get-Content "D:\DSH\Yuan Ai\super-brain\50-Skills\xxx.md"

# ③ 写：唯一入口
pwsh "D:\DSH\Yuan Ai\super-brain\scripts\writeback.ps1" `
  -Category 50-Skills -Title "xxx方法论" `
  -Source "agent:lead" -Tags 技能,方法论 `
  -Project "阿原工程" -Related "相关笔记" `
  -Content "方法论正文……"

# ④ 核对：输出必须含 PUSH=OK
```

## 4. 分工约束（多 Agent 并发）

- 并发写**不同文件**天然安全；并发写**同一文件**时后提交者会触发 rebase 冲突 → 云端胜出，其内容丢失方需重新读取后二次回写。
- Team 多成员协作时，各成员回写前先各自 `sync.ps1 -PullOnly`。
- 破坏性操作（删除目录、改名、批量清理）只允许 lead 执行，且必须先 push 检查点再动手。
