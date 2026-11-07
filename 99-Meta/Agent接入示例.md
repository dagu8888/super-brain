---
id: meta-agent-access
title: Agent 接入示例（git 通道 + GitHub API 通道）
created: "2026-11-01"
updated: "2026-11-01"
tags: [meta, agent, 接入]
status: evergreen
related: ["[[AGENTS]]"]
---
# Agent 接入示例

## A. 本机 Agent（git 通道，首选）
```powershell
# 首次
git clone https://github.com/dagu8888/super-brain.git "D:\DSH\Yuan Ai\super-brain"

# 每次开工
pwsh "D:\DSH\Yuan Ai\super-brain\scripts\sync.ps1" -PullOnly

# 每次产出（唯一写入口）
pwsh "D:\DSH\Yuan Ai\super-brain\scripts\writeback.ps1" -Category 00-Inbox `
  -Title "2026-11-01 与原AI对话要点" -Source "chat:DSH" -Tags 回写,聊天记录 `
  -Content "要点……原文……"
```

## B. 外部 Agent / 其它机器（GitHub API 通道）
凭据用只读或细粒度 PAT（环境变量 `GITHUB_TOKEN`，禁止写死在文件里）。

```bash
# 读文件
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/dagu8888/super-brain/contents/50-Skills/index.md?ref=main" \
  | jq -r .content | base64 -d

# 写文件（PUT，自动提交到 main）
BODY=$(jq -n --arg msg "agent: 回写" --arg content "$(echo '正文' | base64 -w0)" \
  '{message:$msg, content:$content, branch:"main"}')
curl -s -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/dagu8888/super-brain/contents/00-Inbox/外部Agent回写-示例.md" \
  -d "$BODY"
```

**外部 Agent 三条铁律**：先 GET 再 PUT（拿到云端最新 sha）；PUT 的 message 前缀 `agent:<名字>:`；一次只写自己负责的路径，冲突以云端为准重读重写。

## C. CodeBuddy 子代理
- `permission_mode=plan`（只读审查），需要写知识库时把结论交回 lead，由 lead 走 writeback.ps1。
