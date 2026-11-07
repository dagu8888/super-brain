---
id: meta-writeback-sop
title: 回写 SOP（强制）
created: "2026-11-01"
updated: "2026-11-01"
tags: [meta, 回写, SOP]
status: evergreen
related: ["[[AGENTS]]"]
---
# 成果回写 SOP

> Agent（含 lead 自己）完成**任何**工作后，以下四类产物必须回写云端知识库，缺一不可：
> ① 复盘　② 新技能/方法论/模板　③ 聊天记录/录音转写　④ 外部资料

## 落位对照表

| 产物 | 目录 | 模板 | 标签 |
|---|---|---|---|
| 工作复盘 | `60-Daily/` 或 `10-Projects/项目名` | tpl-复盘 | 复盘 |
| 新技能/方法论 | `50-Skills/` | tpl-技能 | 技能, 方法论 |
| 新模板 | `90-Templates/` | — | 模板 |
| 聊天记录 | `00-Inbox/` | tpl-回写-聊天记录 | 回写, 聊天记录 |
| 录音转写 | `00-Inbox/` | tpl-回写-聊天记录 | 回写, 转写 |
| 外部资料 | `30-Resources/`（原始件可先放 `00-Inbox/`） | tpl-回写-外部资料 | 回写, 外部资料 |

## 五步法（统一入口 writeback.ps1）

```powershell
# 1. 拉最新（离线可跳过，用 -NoSync）
pwsh scripts/sync.ps1 -PullOnly

# 2. 回写（自动注入 frontmatter：id/created/updated/source/tags/status/project/related）
pwsh scripts/writeback.ps1 -Category 50-Skills -Title "xxx方法论" `
  -Source "agent:lead" -Tags 技能,方法论 -Project "项目名" `
  -Content "（正文；或 -BodyFile 指向现成 md/txt）"

# 3. 补双链：打开新笔记，related 至少 1 条（没有就留默认 [[MOC-总索引]]）

# 4. 脚本自动 pull --rebase + push（核对输出 PUSH=OK）

# 5. 过一遍 [[99-Meta/回写检查清单|回写检查清单]]
```

## frontmatter 自动注入
`writeback.ps1` 自动生成：`id`（yyyyMMdd-HHmmss）、`created`、`updated`、`source`、`tags`、`status`、`project`（双链）、`related`（双链，缺省 `[[MOC-总索引]]`）。

## 大件资料
- 转写稿/长文 > 50KB：正文放 `30-Resources/`，`00-Inbox/` 里放索引卡（摘要+双链）。
- 图片/音频等附件：存 `99-Meta/附件/`，笔记里引用相对路径。

## 反向约束
回写完成 ≠ 记忆完成：重要结论还要进 Agent 长期记忆（memory_save），知识库存全文，记忆库存索引要点。
