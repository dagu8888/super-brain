# sync.ps1 — 强制同步脚本（pull --rebase + push，云端优先）
# 规则全文见 99-Meta/同步规则.md
param(
  [string]$Message = '',
  [switch]$PullOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if (-not (Test-Path (Join-Path $root '.git'))) { throw '不是 git 仓库：先完成 push-ready.ps1 初始化' }
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'

# 1. 云端连通检查（云端不通 = 不落盘）
$null = git ls-remote origin HEAD 2>$null
if ($LASTEXITCODE -ne 0) { throw '云端仓库不可达（网络/凭据）。可先 writeback.ps1 -NoSync 暂存，恢复后立即同步。' }

# 2. 本地变更先提交
if (git status --porcelain) {
  if (-not $Message) { $Message = "sync: 自动提交 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
  git add -A
  git commit -m $Message | Out-Null
  "COMMIT=$Message"
}

# 3. pull --rebase（云端优先：rebase 中 ours = 云端基线）
$null = git pull --rebase origin main 2>&1
if ($LASTEXITCODE -ne 0) {
  $conflicts = git diff --name-only --diff-filter=U
  if ($conflicts) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path (Join-Path $root '99-Meta\冲突日志.md') -Value "`n- $stamp 冲突（取云端）：$($conflicts -join ', ')" -Encoding utf8
    git checkout --ours -- . 2>$null
    git add -A
    git -c core.editor=true rebase --continue 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { git rebase --abort 2>$null; throw 'rebase 冲突无法自动解决，已回滚，请人工处理。' }
    "CONFLICT_RESOLVED=云端为准: $($conflicts -join ', ')"
  } else {
    throw 'pull 失败（网络/凭据），已中止。'
  }
}

if ($PullOnly) { git log --oneline -1; 'PULL_ONLY=OK'; exit 0 }

# 4. push
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'push 失败：重跑本脚本（会再次 pull --rebase 后推）。禁止 git push -f。' }
git log --oneline -1
'PUSH=OK'
