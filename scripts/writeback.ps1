# writeback.ps1 — 成果回写唯一入口（自动 frontmatter + 同步）
# 用法示例：
#   writeback.ps1 -Category 00-Inbox -Title "标题" -Source "chat:微信" -Tags 回写,聊天记录 -Content "内容"
#   writeback.ps1 -Category 50-Skills -Title "方法论" -BodyFile D:\tmp\x.md -Project "项目名" -Related "笔记A","笔记B"
param(
  [Parameter(Mandatory = $true)][ValidateSet('00-Inbox','10-Projects','20-Areas','30-Resources','40-Archives','50-Skills','60-Daily')]
  [string]$Category,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Content = '',
  [string]$BodyFile = '',
  [string]$Source = 'agent',
  [string[]]$Tags = @(),
  [string]$Project = '',
  [string[]]$Related = @(),
  [string]$Status = 'seed',
  [switch]$NoSync
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$safe = $Title -replace '[\\/:*?"<>|]', '-'
$safe = $safe.Trim()
if (-not $safe) { throw '标题不能为空' }

if ($Category -eq '60-Daily') {
  $file = Join-Path $root "60-Daily\$(Get-Date -Format 'yyyy-MM-dd')-$safe.md"
} else {
  $file = Join-Path (Join-Path $root $Category) "$safe.md"
}
if (Test-Path $file) { throw "已存在: $file（换标题或手工合并后 sync.ps1）" }

$id = Get-Date -Format 'yyyyMMdd-HHmmss'
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
if (-not $Tags -or $Tags.Count -eq 0) { $Tags = @('回写') }
$tagsYaml = '[' + (($Tags | ForEach-Object { $_.Trim() }) -join ', ') + ']'
if ($Related.Count) { $relYaml = '[' + (($Related | ForEach-Object { '"[[' + $_ + ']]"' }) -join ', ') + ']' }
else { $relYaml = '["[[MOC-总索引]]"]' }
$projYaml = if ($Project) { '"[[' + $Project + ']]"' } else { '""' }

$body = if ($BodyFile) { Get-Content $BodyFile -Raw -Encoding UTF8 } else { $Content }

$md = @"
---
id: "$id"
title: "$Title"
created: "$now"
updated: "$now"
source: "$Source"
tags: $tagsYaml
status: $Status
project: $projYaml
related: $relYaml
---

# $Title

$body

## 双链
- [[MOC-总索引]]
"@

[System.IO.File]::WriteAllText($file, $md, (New-Object System.Text.UTF8Encoding($false)))
"WRITTEN=$file"

if (-not $NoSync) {
  & (Join-Path $PSScriptRoot 'sync.ps1') -Message "writeback: $Title"
} else {
  'NOSYNC=本地暂存，未推送（恢复云端后立即 sync.ps1）'
}
