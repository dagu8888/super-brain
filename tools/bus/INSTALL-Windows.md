# 节点桥 Windows 安装说明

把本机 Agent（MAUS1 号 / MAUS2 号 / DSH一号 / DSH二号 等）接到中台消息总线，开机自启、挂了重拉。只需 Python 3 标准库，不必再装依赖。

## 1. 准备

1. 本机已安装 Python 3.9+（`py -3 --version` 能跑）。
2. 仓库已同步到本机（例如 `C:\super-brain`），本说明以该路径为例，按实际修改。
3. 向大古领取**本身份专属口令**（与 `/cmd` 的 chief 口令相同）。口令只进本机环境变量或本机配置，**不要提交到 git、不要写进计划任务命令行、不要写进日志**。

## 2. 写配置

```powershell
cd C:\super-brain\tools\bus
copy agent-bridge.example.json agent-bridge.json
notepad agent-bridge.json
```

按身份改这几项：

| 字段 | MAUS1 号 | MAUS2 号 | DSH一号@主机 | DSH二号@笔记本 |
|---|---|---|---|---|
| `instance` | 登记在名册中的实例名 | 同上 | `DSH一号@主机` | `DSH二号@笔记本` |
| `agent_id` | `maus-chief` | `maus2-chief` | `dsh-chief` | `dsh2-chief` |
| `handler` | `openmaus` | `openmaus` | `none`（仅传输层回执，见下） | `none` |

DSH 一号 / 二号是 Grok Bot，agent 层的实质回复还不能由本桥直接唤醒模型；先保持 `handler=none`，点名（`kind=ping`）会自动回 `1 · 实例 · 收到于北京时间`（`layer=transport`）。agent 层回复后续经 Grok Bot webhook 或人工转达，见 `40-Agents/实时消息总线-v1.md`。

MAUS 侧若本机 8799 已开，先保持 `openmaus.mode=auto`。桥启动时会探一次 8799 的返回形态并写入 `bridge.log`（不含口令），再按兼容字段抽取回答。

## 3. 配置口令（推荐环境变量）

当前用户级（新开的终端和计划任务都能读到）：

```powershell
[System.Environment]::SetEnvironmentVariable(
  "SUPERBRAIN_GATEWAY_TOKEN",
  "这里填本身份口令",
  "User")
```

重新打开一个 PowerShell，确认有值、且不要把它打印到聊天或工单里：

```powershell
if ($env:SUPERBRAIN_GATEWAY_TOKEN) { "token is set" } else { "MISSING" }
```

## 4. 先手工跑通

```powershell
cd C:\super-brain\tools\bus
py -3 agent-bridge.py --once          # 连上中台即退出，确认在场
py -3 agent-bridge.py                 # 常驻。看到「SSE 已建立（在场心跳中）」即成功
```

日志在同目录 `bridge.log`。用另一台已配好的 box 执行：

```bash
python tools/bus/sbmsg.py send --to all --kind ping "所有在线 Agent 回复 1"
python tools/bus/sbmsg.py rollcall <上一步返回的 msg_id>
```

本机应在数秒内出现 `layer=transport` 的回执，rollcall 里能看到时延秒数。

## 5. 开机自启 + 挂了重拉

用同目录的 `watchdog.ps1` 注册计划任务（每 2 分钟检查一次，进程不在就拉起；开机也跑一次）：

```powershell
cd C:\super-brain\tools\bus
# 若 Python 不在默认路径，先设：$env:SB_PYTHON = "C:\Path\to\python.exe"
powershell -ExecutionPolicy Bypass -File .\watchdog.ps1 -Install
```

卸掉：

```powershell
powershell -ExecutionPolicy Bypass -File .\watchdog.ps1 -Uninstall
```

任务名默认 `SuperBrain-AgentBridge`。看门狗只检查 `agent-bridge.py` 进程是否在跑，不把口令写进任务参数。
