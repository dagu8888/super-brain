---
layer: 编译层
type: 实体页
valid_from: 2026-11-08
confidence: 文档依据
title: grok-bot 接入超级大脑知识库
source: [10-Knowledge/Playbooks/grok-bot-接入超级大脑知识库.md]
status: 现行
---

# grok-bot 接入超级大脑知识库

> grok-bot 完成仓库拉取、环境自检与同步上传，正式接入协作体系
> 来源：00-Inbox/2026-11-08-grok-bot接入超级大脑-grok.md ｜ 2026-11-08 由 knowledge-worker 自动整理

# grok-bot 接入超级大脑知识库

## Agent 身份与环境
- Agent 名：grok（grok-bot），署名后缀 `-grok`
- 运行载体：DeepSeek Harness（DSH），工作目录 `D:\DSH`
- Git 位置：`C:\Program Files\Git\cmd\git.exe`（Windows，含 Git Bash）
- 仓库本地副本：`D:\DSH\super-brain`（origin: https://github.com/dagu8888/super-brain）
- 凭据：Git Credential Manager（credential.helper=manager），push 走系统凭据

## 本地项目登记（本机可执行内容）
| 项目 | 路径 | 说明 |
|---|---|---|
| xiaozhi-esp32 | `D:\WorkSpace\xiaozhi-esp32` | ESP32 语音助手固件工程 |
| xiaozhi-esp32-server | `D:\WorkSpace\xiaozhi-esp32-server-0.1.14` | 小智语音服务端 0.1.14 |
| Grok Bot 客户端 | `D:\Grok Bot` | Grok Bot 应用安装目录（数据在 `%APPDATA%\Grok Bot`） |
| Obsidian | `D:\DSH\Obsidian` | Obsidian 应用安装目录 |

> 说明：以上为应用/工程目录，知识类内容不落盘在本地，按铁律全部直接写入本仓库。

## 遵守规则确认
1. ✅ 唯一信息源：所有笔记直接写本仓库，不留本地副本
2. ✅ 分区写入：只写 `00-Inbox/` 与 `60-Outputs/YYYY-MM-DD/`，文件命名 `YYYY-MM-DD-主题-grok.md`
3. ✅ 不修改 `40-Agents/`、`90-System/` 及他人文件
4. ✅ 每次写入前 pull，写入后立即 sync（`AGENT_NAME=grok bash 90-System/sync/sync.sh`）
5. ✅ 任务前先查仓库已有内容避免重复（本次已核对 00-Inbox、50-Events、60-Outputs 现状）

## 仓库现状快照（2026-11-08 07:00 +08:00）
- 分支 main，HEAD `0737b0e step6: 升级完成报告`，与 origin/main 同步
- 00-Inbox 仅 README.md，无其他 Agent 待整理内容
- watchdog 日志：06:47 记录 `auto_push_ok`

## 相关链接
- [[2026-11-08-架构升级复盘-mausbot]]
- [[升级完成报告]]
