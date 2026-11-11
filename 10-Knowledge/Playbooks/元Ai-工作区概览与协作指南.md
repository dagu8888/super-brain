---
layer: 编译层
type: 实体页
status: 已失效
valid_to: 2026-11-11
superseded_by: "[[10-Knowledge/Concepts/元Ai-工作区概览与协作指南]]"
confidence: 文档依据
---

# 元Ai 工作区概览与协作指南

> 元Ai 主工作区总览地图与多 Agent 协作规范
> 来源：00-Inbox/元Ai 工作区概览与协作指南.md ｜ 2026-11-08 由 knowledge-worker 自动整理

# 元Ai 工作区概览与协作指南

## 一句话结论

本文是元Ai 主工作区 `D:\DSH\Yuan Ai` 的总览地图，供接入 super-brain 的所有 Agent 对齐现状、查重避撞、找到协作入口。

## 身份与使命

- 对外唯一身份「元Ai」，Team Lead 会话名 lead；娜娜/茉莉为内部工作模式（lead/care），不对外暴露。
- 共同使命：培育真正懂用户的全能元Ai——控制台 + 多 Agent 协作 + 跨工作区记忆 + 影视/游戏生产，四线并进。

## 主要板块

| 板块 | 位置 | 说明 |
|---|---|---|
| 控制台与运维 | agents/ ops/ deploy/ tools/ data/ | DSH 控制台、作战大屏、启停脚本（start.bat / stop.bat） |
| VRM 三角色与姿势库 | assets/characters、characters/ | three 0.160 + three-vrm 3.0，验收前提：三角色先统一姿势再匹配骨架 |
| 长期记忆库 | memory-vault/ | Obsidian vault，Markdown 为唯一事实源 |
| 文档/研究/宪法 | docs/ research/ yang/ | 阿原工程宪法在 yang/L0-constitution/（含第十三条「内容不设审」） |
| 知识库 | super-brain/ | 本仓库本地克隆（origin: github.com/dagu8888/super-brain，私有） |
| Toonflow 无限画布 | D:\DSH\toonflow无线画布视频工作流\toonflow-app | 短剧/漫剧/无限画布视频工作流，http://127.0.0.1:3000 |

## 能力清单（工具链）

- 影视生产：dsh-agnes-studio（37 个技能：短剧 11 / 网文 13 / 视频解说 6 / 小说改游戏 7）+ dsh-grok-imagine（Grok 生图/生视频）
- 记忆栈：dsh-full-life-memory（物理遗忘）+ dsh-memory-gate（注入硬预算）+ longterm-memory vault（本表 memory-vault）
- 终端能力：ego browser（浏览器自动化）、phone_*（手机控制）、send_wechat（微信推送）、飞书文档读写
- 模型网关：workbuddy（glm 系）等

## 与其他 Agent 的协作约定

1. 接任务先 `sync.ps1 -PullOnly` 再查仓库，先查已有内容，避免重复劳动；
2. 写入只走 `writeback.ps1` / `new-note.ps1`，冲突云端优先；
3. 需要元Ai（lead）协作：共享任务板派单，或直接发消息给 lead；
4. 结构层（90-Templates / 99-Meta / AGENTS.md / scripts）一律不改动；删除/改名仅 lead，且先推检查点。

## 现状与待办

- 2026-11-08：本笔记经 `writeback.ps1 -NoSync` 暂存——云端凭据待用户本人授权（浏览器 OAuth 或 PAT），凭据通后随 `sync.ps1` 首推。
- 云端凭据恢复路径：`push-ready.ps1 -BrowserLogin` 或 `-Token <PAT>`（依据 99-Meta/同步规则.md R4）。

## 双链

- [[MOC-总索引]]
