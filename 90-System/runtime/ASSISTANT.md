# 操作台语音助手：官方 DeepSeek

日常语音由 Super-Brain 后端流式转发到官方 `https://api.deepseek.com/chat/completions`。模型固定为 `deepseek-flash`，`stream` 为 true，`thinking` 为 `{type: disabled}`。文字输入框仍直接发给幕僚长。本文件不含密钥。

香港侧已有一次只读探测：HTTP 200，8 个可见块，首个可见块 0.3378 秒，整段 0.4892 秒。这里的自动化测试不再访问官方接口，也不把那次探测写成新的计费调用。

## 操作台管家角色卡

可编辑正文存在服务端表 `steward_card`，默认文本在 `90-System/runtime/assistant_store.py` 的 `DEFAULT_CARD`。每次请求由 `compose_system` 在正文后附上 `LOCKED_RULES`。改角色卡不会改掉这段约束，也不会改变 A/B/C 的程序判断。

管家对话记在 `steward_turns`，和给幕僚长的 `messages` 分开。模型短上下文仍只留最近 6 条。部分识别不入库。只有点击「交给幕僚长：打包本段」才把本段草稿发给幕僚长，并要有 `msg_id`。

## 环境变量

只放在运行 `api_server` 的进程环境里（现有 `super-brain.service` 所在进程）。不要写进仓库、前端或日志。

| 变量 | 作用 |
| --- | --- |
| `SB_DEEPSEEK_API_KEY` | 官方密钥。空着时接口直接告诉用户未接通，不会用模拟回答顶上 |
| `SB_ASSISTANT_BASE_URL` | 可省略。只接受 `https://api.deepseek.com`，其它值拒绝且不连接 |
| `SB_ASSISTANT_MODEL` | 可省略。只接受 `deepseek-flash`。`deepseek/deepseek-flash` 是另一条线路的别名，这里不接受 |
| `SB_ASSISTANT_TIMEOUT_S` | 可省略，默认 20，最大 45 |
| `SB_ASSISTANT_MAX_TOKENS` | 可省略，默认 512，最大 1024 |
| `SB_ASSISTANT_MAX_CHARS` | 可省略，默认 800，最大 2000 |

余额不足（HTTP 402）后，进程停止再向官方发出对话，直到进程重启。不会自动充值，也不会在后台循环生成。

## 权限

程序强制，不靠提示词：

- A：日常问答走官方流；`服务器健康` 等整句只读 `GET /api/server`；`setTab` / `go` / `scrollChat` / `setVoicePanelCollapsed` / 停朗读 / 显式关麦只在用户原话对得上时执行。
- B：用户说「告诉幕僚长 / 让幕僚长办」，或原话里有跨项目、多步骤、需要幕僚长协助、交给幕僚长，并且模型提议 `handoff` 时，才 `post_message` 一次。有 `msg_id` 才说已转交。
- C：删除、下单、改设置等句子不执行，也不转交幕僚长代批。

朗读仍用现有文静队列，默认关闭。打断只停播放和这一轮流，显式关麦才停音轨。

## 部署

本变更合入并发布前，不要在开发机上注入生产密钥。发布由操作者做：

1. 审阅并合并本 PR。
2. 在服务器上把 `SB_DEEPSEEK_API_KEY` 放进 `super-brain.service` 的 root-only drop-in 或同等环境文件，权限 600。不要把密钥提交到 git。
3. 确认没有设置别的 `SB_ASSISTANT_BASE_URL` / `SB_ASSISTANT_MODEL`；省略即官方默认。
4. 重启 `super-brain.service`，让 `api_server` 读到新环境。不新开端口，不改 STT，不改 bot / routine。
5. 用主人会话打开操作台。语音说一句普通中文，应看到 `deepseek-flash` 的流式文字。匿名访问 `/api/owner/assistant/stream` 仍是 401。

## 回滚

1. 把服务版本退回合并前的 `19385ce`（操作台 2.8.6），或 revert 本 PR。
2. 从服务环境里去掉 `SB_DEEPSEEK_API_KEY`。
3. 重启 `super-brain.service`。
4. 确认页面不再请求 `/api/owner/assistant/stream`，匿名业务接口仍是 401，欢迎语和语音设置入口仍在。

## 测试

```bash
python3 90-System/runtime/tests/test_assistant_deepseek.py
python3 90-System/runtime/tests/test_assistant_mock.py
python3 90-System/runtime/tests/test_console_voice.py
```

硬件麦克风未在本环境验收。
