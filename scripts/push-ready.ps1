# push-ready.ps1 — 一键云端就绪：验证凭据 → 建仓 → 配远端 → 首推
# 用法：
#   push-ready.ps1                    # 用凭据管理器现有凭据
#   push-ready.ps1 -BrowserLogin      # 弹浏览器重新授权（推荐：凭据过期时）
#   push-ready.ps1 -Token ghp_xxx     # 用指定 PAT（repo 权限）
param(
  [string]$Token = '',
  [string]$RepoName = 'super-brain',
  [switch]$BrowserLogin
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
$env:GCM_INTERACTIVE = 'never'

if ($BrowserLogin) {
  # 清掉过期凭据，触发 GCM 浏览器授权（需要人在浏览器点一次 Authorize）
  cmdkey /delete:"git:https://github.com" 2>$null | Out-Null
  cmdkey /delete:"git:https://dagu8888@github.com" 2>$null | Out-Null
  $env:GCM_INTERACTIVE = 'auto'
  $fill = "url=https://github.com`n`n" | git credential fill 2>$null
  $Token = ($fill | Where-Object { $_ -like 'password=*' }) -replace 'password=', ''
  if (-not $Token) { throw '浏览器授权未完成' }
}
if (-not $Token) {
  $fill = "url=https://github.com`n`n" | git credential fill 2>$null
  $Token = ($fill | Where-Object { $_ -like 'password=*' }) -replace 'password=', ''
}
if (-not $Token) { throw '无凭据：push-ready.ps1 -BrowserLogin 或 -Token <PAT>' }

$hdr = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'dsh-kb-setup' }
$u = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $hdr -TimeoutSec 25
"LOGIN=$($u.login)"

$repoUrl = "https://github.com/$($u.login)/$RepoName"
try {
  $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$($u.login)/$RepoName" -Headers $hdr -TimeoutSec 25
  "REPO_EXISTS=$($r.html_url)"
} catch {
  $body = @{ name = $RepoName; private = $true; description = '阿原超级大脑 | Obsidian 云端知识库 · 唯一信息源 (Single Source of Truth)'; auto_init = $false } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $hdr -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  "REPO_CREATED=$($r.html_url)"
}

# 凭据写回凭据管理器（不落明文文件）
"protocol=https`nhost=github.com`nusername=$($u.login)`npassword=$Token`n" | git credential approve

# 远端 + 首推
$remote = "$repoUrl.git"
if ((git remote) -notcontains 'origin') { git remote add origin $remote } else { git remote set-url origin $remote }
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'push 失败，检查网络后重跑' }
git ls-remote origin HEAD
"DONE=$repoUrl"
