# Mausbot 本地项目总览

> 盘点 D:\DSH 下四个自有项目与资产
> 来源：00-Inbox/2026-11-08-Mausbot本地项目总览-maus.md ｜ 2026-11-08 由 knowledge-worker 自动整理

# Mausbot 本地项目总览

## 摘要

Mausbot 接入「超级大脑」知识库后，对本地 `D:\DSH` 下四个自有项目/资产做首次盘点回写，供 KnowledgeWorker 后续沉淀、Lead 排期参考。

## 项目清单

### 1. OpenMaus（`D:\DSH\OpenMaus`）

- 全称 **OpenMausBot v0.1.147**：本地优先的 AI Agent 团队聊天应用（Electron + React 19 + TypeScript strict）。
- 上游：`github.com/milind-soni/OpenMausBot`（Apache-2.0）；要求 Node >= 24，pnpm@10.33.0。
- 目录：`apps/` `server/` `electron/` `companion/` `connector/` `relay/` `shared/` `skills/` `evals/` `cloudflare/` 等。
- 状态：本地工作副本，dev/build 可用；Mausbot 主力执行/监控载体候选。

### 2. AIOS（`D:\DSH\AIOS`）

- **dsh-aios v0.12.1**：DSH 插件（Cordis bundle patch），"V4 Wave 5A：管理观测层"，10 个模块，接 host/store 真实数据。
- 说明文档：`DSH-AIOS V4.0 完整开发总指令.md`、`DSH-AIOS 插件项目：完整工程化开发总指令.md`。
- 状态：开发中（Wave 5A）。

### 3. AIOS-V4.0（`D:\DSH\AIOS-V4.0`）

- **aios v1.0.0**：独立运行的「个人 AI 操作系统」monorepo（`apps/server` + `apps/web`），Node >= 22.5，vitest。
- 状态：本地运行环境（`data/` 含 sqlite 等运行数据）。

### 4. chajian（`D:\DSH\chajian`）

- DSH 插件相关资产：角色卡（DSH指令优化师）、`magpie_api.json`、`pc-check/` 运维脚本、PATH/proxy 环境备份。
- 状态：杂项资产目录，插件调试用。

## 待办 / 分工

- Mausbot 后续产物默认进 `60-Outputs/YYYY-MM-DD/`，署名 `maus`；未分类笔记进 `00-Inbox/`。
- 本文仅索引本地资产，未向仓库复制代码/二进制；如需沉淀详细开发笔记或上传附件，请 Lead 指示。

## 相关链接

- [[权限与同步规则]]
- [[接入授权-Grok-Maus]]
