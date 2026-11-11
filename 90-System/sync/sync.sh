#!/usr/bin/env bash
# 超级大脑同步脚本：本地工作副本 ⇄ 云端唯一信息源
# 用法: bash 90-System/sync/sync.sh "可选提交说明"
# 署名: AGENT_NAME=grok bash 90-System/sync/sync.sh
set -uo pipefail

# P0 互斥锁：同机多 git 进程串行化（cron sync / watchdog 自愈 / 人工 共用一把锁，抢不到就跳过等下轮）
exec 9>/tmp/superbrain-git.lock
flock -n 9 || { echo "SKIP_LOCKED: 另一个 git 进程正在运行，下轮再试"; exit 0; }

cd "$(dirname "$0")/../.." || exit 1
AGENT="${AGENT_NAME:-unknown-agent}"
MSG="${1:-sync: $(date '+%Y-%m-%d %H:%M:%S') by ${AGENT}}"

# 2026-11-11 保护：受保护目录（系统代码/Agent 配置）不再由定时同步自动提交直推 main，
# 只能走人工分支 → 测试 → 合并。数据目录照旧每 30 分钟自动同步，所以同步本身不会断。
# 可用环境变量 SYNC_PROTECTED 覆盖（空格分隔）。
PROTECTED="${SYNC_PROTECTED:-40-Agents 90-System}"
EXCLUDES=()
for d in $PROTECTED; do EXCLUDES+=(":(exclude)$d"); done
git add -A -- . "${EXCLUDES[@]}"
if [ -n "$(git status --porcelain -- $PROTECTED 2>/dev/null | head -1)" ]; then
  echo "PROTECTED_PENDING: 受保护目录有未提交改动，已跳过自动提交（需人工分支合并）："
  git status --porcelain -- $PROTECTED | head -5
fi

# 场景一：尚未配置云端仓库 → 仅本地提交，明确提示待同步
if ! git remote get-url origin >/dev/null 2>&1; then
  if git diff --cached --quiet; then
    echo "NO_CHANGES"
  else
    git -c user.name="${AGENT}" -c user.email="${AGENT}@super-brain.local" commit -m "$MSG"
    echo "NO_REMOTE: 已本地提交。配置云端仓库后再运行本脚本会自动推送。"
  fi
  exit 0
fi

# 场景二：已配置云端 → 先拉（rebase+autostash），再推
git pull --rebase --autostash || { echo "PULL_FAILED: 存在冲突，请人工处理后重试"; exit 1; }

if git diff --cached --quiet && [ -z "$(git log origin/$(git branch --show-current)..HEAD 2>/dev/null)" ]; then
  echo "NO_CHANGES"
  exit 0
fi

git diff --cached --quiet || git -c user.name="${AGENT}" -c user.email="${AGENT}@super-brain.local" commit -m "$MSG"
git push && echo "SYNC_OK" || { echo "PUSH_FAILED"; exit 1; }
