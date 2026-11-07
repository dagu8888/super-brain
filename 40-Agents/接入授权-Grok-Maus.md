# Grok bot / Mausbot 接入授权方案

目标：两个 bot 都能读写本仓库，凭据互相独立、可单独吊销，权限最小化。

## 推荐方案：每 bot 一把 Deploy Key（SSH）

优点：不绑定你的个人账号、权限只限本仓库、可随时单独吊销。

**1. 在 bot 运行的机器上生成钥匙（每个 bot 各一把）**

```bash
ssh-keygen -t ed25519 -C "grok-bot" -f ~/.ssh/grok_bot
ssh-keygen -t ed25519 -C "maus-bot" -f ~/.ssh/maus_bot
```

**2. 把公钥挂到仓库**

GitHub → `super-brain` → **Settings** → **Deploy keys** → **Add deploy key**：

- 粘贴 `grok_bot.pub` 的内容，Title 填 `grok-bot`，勾选 **Allow write access**
- 同样方式加 `maus_bot.pub`

**3. bot 侧使用 SSH 地址克隆/同步**

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/grok_bot" git clone git@github.com:dagu8888/super-brain.git
```

sync.sh 无需改动，git 会走对应私钥。

## 备选方案：Fine-grained PAT（最快但绑定你的账号）

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate：

- Repository access：**Only select repositories** → `super-brain`
- Permissions：**Contents: Read and Write**（其他一律不给）
- 每个 bot 各发一个，命名区分，随时可单独 Revoke

bot 用 `https://x-access-token:<PAT>@github.com/dagu8888/super-brain.git` 克隆。

## bot 必守规则（发给他们的话）

> 你已接入「超级大脑」知识库（唯一信息源）。规则：
> 1. 同步前设身份：`export AGENT_NAME=grok`（Mausbot 用 `maus`）
> 2. 只能写 `00-Inbox/` 和 `60-Outputs/YYYY-MM-DD/`，文件名格式 `YYYY-MM-DD-主题-grok.md`
> 3. 写内容用 `80-Templates/` 里的模板
> 4. 写完必须执行 `bash 90-System/sync/sync.sh`，看到 `SYNC_OK` 才算完成；失败要原样报告错误
> 5. 禁止修改 `40-Agents/`、`90-System/` 和别人的文件

## 吊销

- Deploy Key：仓库 Settings → Deploy keys → 删除对应 key，立即生效
- PAT：Settings → Developer settings → 对应 token → Revoke
