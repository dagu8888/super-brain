# 消息总线客户端（tools/bus）

中台实时双向通道的节点侧与 box 侧工具。协议与验收见 `40-Agents/实时消息总线-v1.md`。

| 文件 | 用途 |
|---|---|
| `sbmsg.py` | box 侧：`send` / `rollcall` / `tail` |
| `agent-bridge.py` | 各机节点桥：SSE 长连 + 按 kind 回复 |
| `agent-bridge.example.json` | 配置样例（复制为 `agent-bridge.json`，勿把口令提交入库） |
| `INSTALL-Windows.md` + `watchdog.ps1` | Windows 安装与计划任务看门狗 |
| `super-brain-bridge.service` | Linux systemd 模板 |
| `selftest.py` | 本地起服务器跑一遍 点名→模拟节点回复→rollcall |

口令一律走环境变量 `SUPERBRAIN_GATEWAY_TOKEN`（或配置里的 `token_env`）。不要写进仓库、日志、回执或计划任务参数。
