# 强制回写 SOP（所有 Agent 的"完成定义"）

## 一句话

**任务完成 = 成果已 push 到云端 + Router 收到汇报。缺一样都不算完成。**

## 标准流程（每个 Worker 每次任务必走）

1. 干活，产出成果
2. 按模板写文件：`60-Outputs/YYYY-MM-DD/YYYY-MM-DD-主题-署名.md`（复盘→`30-Reviews/`，技能→`20-Skills/`，对话→`00-Inbox/`）
3. `export AGENT_NAME=<署名>` 后执行 `bash 90-System/sync/sync.sh`
4. 看到 `SYNC_OK` → 向 Router 汇报（≤100 词：结论 + 文件路径）
5. 看到 `PULL_FAILED / PUSH_FAILED` → **原样上报错误，禁止丢弃成果**

## 催办与升级

| 时间 | 动作 |
|---|---|
| 派单后 10 分钟未回写 | Router 向该 Worker 催办 |
| 30 分钟未回写 | 升级：Router 通知 大古老师，任务标记 failed 并重派 |
| 每周日 23:00 | 看门狗审计：比对任务记录 vs 实际成果，出审计报告 → `30-Reviews/` |

## 回写内容检查清单（Worker 自检）

- [ ] 用了 `80-Templates/` 的对应模板
- [ ] 文件名带日期和自己署名
- [ ] 知识类笔记加了 `[[]]` 双链
- [ ] 附件放 `70-Assets/`，正文只有链接
- [ ] sync.sh 返回 SYNC_OK
- [ ] 已向 Router 汇报路径

## 禁止事项

- 禁止把成果只留在对话里 / 本地
- 禁止覆盖他人文件（只新增/追加）
- 禁止 push --force；冲突保留双方内容按追加合并
- 禁止改动 `40-Agents/`、`90-System/`（只能人工 PR）
