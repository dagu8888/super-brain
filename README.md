# 超级大脑知识库（Super Brain）

本仓库是所有 AI Agent（我、Grok bot、Mausbot、未来所有 Worker）的**唯一信息源**。

## 三大铁律

1. **云端唯一**：核心知识只存在本仓库，任何地方（本地、对话里、群聊里）的内容都只是工作副本。
2. **实时同步**：写入前先拉取（pull），写入后立即推送（push）。执行 `bash 90-System/sync/sync.sh` 一键完成。
3. **强制回写**：任何 Agent 产生的复盘、技能、聊天记录、录音、外部资料、执行结果，必须写回本仓库对应目录，否则视为任务未完成。

## 目录结构

| 目录 | 用途 | 谁写 |
|---|---|---|
| `00-Inbox/` | 未分类内容入口（录音转写、剪藏、聊天原文） | 所有 Agent |
| `10-Knowledge/` | 沉淀后的正式知识，必须用 `[[]]` 双链 | KnowledgeWorker 整理 |
| `20-Skills/` | 新生成的技能（按技能模板） | 所有 Agent |
| `30-Reviews/` | 复盘：日报/周报/事件复盘 | 所有 Agent |
| `40-Agents/` | Router/Worker/看门狗配置（配置即代码） | 架构师 |
| `50-Events/` | 事件日志（只追加，供审计回放） | Gateway/Watchdog |
| `60-Outputs/` | Worker 执行成果，按 `YYYY-MM-DD/` 分日 | Workers |
| `70-Assets/` | 附件：图片、录音、PDF 等 | 所有 Agent |
| `80-Templates/` | 模板（复盘/技能/笔记/聊天记录） | 架构师 |
| `90-System/` | 运维：同步脚本、看门狗、SOP | 架构师 |

## 文件命名规范

```
YYYY-MM-DD-主题-来源agent.md
例：2026-11-08-架构升级复盘-mausbot.md
```

**分区写入防冲突**：每个 Agent 只写自己名字结尾的文件；不覆盖他人文件，只追加。

---

## 给其他 Agent 的接入指令（直接复制发给 Grok bot / Mausbot）

> 你是「超级大脑」知识库的一名 Agent。本仓库是唯一信息源，你必须遵守：
> 1. 你的一切重要产出必须写入本仓库，禁止只留在对话或本地。
> 2. 写入位置：未分类内容→`00-Inbox/`；复盘→`30-Reviews/`；新技能→`20-Skills/`；正式知识→`10-Knowledge/`；执行成果→`60-Outputs/YYYY-MM-DD/`；附件→`70-Assets/`。
> 3. 文件名一律用 `YYYY-MM-DD-主题-你的名字.md`，只新增/追加，不覆盖别人的文件。
> 4. 写内容时使用 `80-Templates/` 里的对应模板，知识类笔记之间用 `[[双链]]` 互相引用。
> 5. 写完后执行 `bash 90-System/sync/sync.sh` 同步到云端；如果没有网络/权限，明确告诉我"已写入本地，待同步"。

---

## Obsidian 使用

1. 下载安装 Obsidian：https://obsidian.md
2. 打开 Obsidian →「打开本地仓库 / Open folder as vault」→ 选择本文件夹。
3. 已预置配置：附件自动存入 `70-Assets/`、模板目录指向 `80-Templates/`、双链自动更新、关系图谱按目录着色。
4. 写新笔记：`Ctrl/Cmd+P` → 输入「模板」→ 插入模板。

## 同步

```bash
bash 90-System/sync/sync.sh            # 拉取 → 提交 → 推送
AGENT_NAME=grok bash 90-System/sync/sync.sh "本次说明"   # 署名同步
```

详细规则见 `90-System/sync/同步规则.md`。
