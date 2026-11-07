# 阿原超级大脑 · super-brain

> **云端仓库 = 唯一信息源（Single Source of Truth）**
> 本地目录 `D:\DSH\Yuan Ai\super-brain` 只是**工作副本**。一切核心知识以 GitHub `main` 分支为准，本地禁止独立沉淀。

- 仓库地址：`https://github.com/dagu8888/super-brain`（private）
- 首次接入：`git clone https://github.com/dagu8888/super-brain.git`
- Agent 强制规范：[[AGENTS]]
- 同步规则：[[99-Meta/同步规则|同步规则]]
- 回写 SOP：[[99-Meta/回写SOP|回写SOP]]

---

## 一、目录规范（PARA + 技能 / 日记 / 元数据）

| 目录 | 用途 | 典型内容 |
|---|---|---|
| `00-Inbox/` | 收集箱 | 聊天记录、录音转写、灵感、外部资料原始件（每周清空一次） |
| `10-Projects/` | 项目 | 有明确终点的事：目标 / 里程碑 / 进展日志 / 复盘 |
| `20-Areas/` | 领域 | 长期责任田：健康、财务、事业、关系、学习等 |
| `30-Resources/` | 资源 | 外部资料、文章摘录、素材库、参考文献 |
| `40-Archives/` | 归档 | 已完结项目、失效内容（不删除，只归档） |
| `50-Skills/` | 技能与方法论 | 可复用的技能卡、SOP、检查清单、经验教训 |
| `60-Daily/` | 日记与复盘 | `YYYY-MM-DD-标题.md` 日记、每日/项目复盘 |
| `90-Templates/` | 模板 | 所有 tpl-*.md 模板，勿放正文 |
| `99-Meta/` | 元数据 | MOC 总索引、同步/回写规范、自动生成的 INDEX、冲突日志 |

## 二、笔记规范

1. **全部 Markdown + YAML frontmatter**，七件套必填：

```yaml
---
id: "20261101-153000"        # 唯一ID：日期-时间（writeback.ps1 自动生成）
title: "笔记标题"
created: "2026-11-01 15:30:00"
updated: "2026-11-01 15:30:00"
source: "agent:lead"          # manual / agent:xxx / chat:微信 / web:URL / voice:转写
tags: [标签1, 标签2]
status: seed                  # seed（种子）→ growing（生长中）→ evergreen（常青）→ archived（归档）
project: "[[项目名]]"         # 可选，双链关联项目
related: ["[[相关笔记]]"]     # 可选，双链关联笔记
---
```

2. **双链**：正文用 `[[笔记名]]`；每条笔记至少 1 条双链（没有就链 [[MOC-总索引]]）。
3. **标签**：一律写 frontmatter `tags`；正文内 `#标签` 只作临时草标。
4. **文件名 = 标题**，禁用 `\ / : * ? " < > |`（writeback 自动转连字符）。
5. 一条笔记只说一件事；超过一屏就拆分并互相双链。

## 三、快速命令（人和 AI 统一走脚本）

| 动作 | 命令 |
|---|---|
| 开工拉取（读之前必跑） | `pwsh scripts/sync.ps1 -PullOnly` |
| 回写一条内容（写完自动 pull+push） | `pwsh scripts/writeback.ps1 -Category 00-Inbox -Title "标题" -Source "chat:微信" -Tags 聊天记录 -Content "内容"` |
| 从模板建笔记 | `pwsh scripts/new-note.ps1 -Template 技能 -Title "xxx方法论"` |
| 生成/刷新索引与图谱统计 | `pwsh scripts/index-build.ps1`（周报加 `-Weekly`） |
| 一键云端就绪（配凭据+建仓+推送） | `pwsh scripts/push-ready.ps1` |

## 四、自动机制

- 每日 23:30 自动索引 + 同步（计划任务 `DSH-KB-Daily-Index`）
- 每周日 22:00 自动周报 + 同步（计划任务 `DSH-KB-Weekly-Index`）
- 注册/卸载：`pwsh scripts/setup-task.ps1` / `-Remove`

## 五、禁止事项

1. 本仓库之外独立保存任何核心知识（本地只能是工作副本）。
2. 绕过脚本手工改文件后不同步。
3. `git push -f`（任何情况下禁止强推 `main`）。
4. 把 token / 密码写进任何笔记或脚本。
