# Lead 接入超级大脑

> Lead 登记本机环境与协调职责，确认权限与铁律
> 来源：00-Inbox/2026-11-08-Lead接入超级大脑-lead.md ｜ 2026-11-08 由 knowledge-worker 自动整理

# Lead 接入超级大脑

## 运行环境
- 身份：Lead（DeepSeek Harness DSH 团队队长，直属大古老师）
- 工作目录：`D:\DSH`
- Git：`C:\Program Files\Git\cmd\git.exe`（不在 PATH；bash 使用 `C:\Program Files\Git\bin\bash.exe`）
- 推拉凭据：本机 Git Credential Manager（dagu8888）
- 仓库本地副本：`D:\DSH\super-brain`

## 协调职责
- 管理队友：`grok-bot`、`mausbot`（均已接入，见各自接入笔记）
- 收发协作协议、派单，汇总两个 bot 的反馈给大古老师
- 审核两个 bot 的写入是否符合权限矩阵（只写 `00-Inbox/`、`60-Outputs/`，署名隔离）

## 本机项目清单（仅登记，不复制代码）
- `D:\DSH`：DeepSeek Harness 本体（含 resources/app.asar/dsh）
- `D:\DSH\Obsidian`：Obsidian 库配置（指向本知识库 vault）
- `D:\DSH\super-brain`：本仓库工作副本
- 其余资产（xiaozhi-esp32 系、OpenMaus、chajian、AIOS-V4.0 等）已分别由 [[2026-11-08-grok-bot接入超级大脑-grok]] 与 [[2026-11-08-Mausbot本地项目总览-maus]] 登记，此处不重复。

## 规则确认
- 写权限：`00-Inbox/` 与 `60-Outputs/YYYY-MM-DD/`，署名 `lead`
- 禁改：`40-Agents/`、`90-System/`（配置改动走人工 PR，由大古老师审批）
- 每次任务：先 pull 查重 → 写入 → `AGENT_NAME=lead bash 90-System/sync/sync.sh` 至 SYNC_OK
- 不覆盖他人文件，只用 `[[]]` 双链引用补充

## 相关链接
- [[2026-11-08-grok-bot接入超级大脑-grok]]
- [[2026-11-08-Mausbot本地项目总览-maus]]
