# new-note.ps1 — 从模板建笔记（占位符自动填充）
# 用法：new-note.ps1 -Template 技能 -Title "xxx方法论" [-Folder 50-Skills/子目录]
param(
  [Parameter(Mandatory = $true)][ValidateSet('笔记','项目','领域','资源','日记','复盘','技能')]
  [string]$Template,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Folder = '',
  [switch]$NoSync
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$map = @{
  '笔记' = @{ tpl = 'tpl-笔记.md'; dir = '00-Inbox' }
  '项目' = @{ tpl = 'tpl-项目.md'; dir = '10-Projects' }
  '领域' = @{ tpl = 'tpl-领域.md'; dir = '20-Areas' }
  '资源' = @{ tpl = 'tpl-资源.md'; dir = '30-Resources' }
  '日记' = @{ tpl = 'tpl-日记.md'; dir = '60-Daily' }
  '复盘' = @{ tpl = 'tpl-复盘.md'; dir = '60-Daily' }
  '技能' = @{ tpl = 'tpl-技能.md'; dir = '50-Skills' }
}
$m = $map[$Template]
$tplPath = Join-Path $root "90-Templates\$($m.tpl)"
$destDir = if ($Folder) { Join-Path $root $Folder } else { Join-Path $root $m.dir }
New-Item -ItemType Directory -Force $destDir | Out-Null

$safe = ($Title -replace '[\\/:*?"<>|]', '-').Trim()
$dest = Join-Path $destDir "$safe.md"
if (Test-Path $dest) { throw "已存在: $dest" }

$content = Get-Content $tplPath -Raw -Encoding UTF8
$content = $content -replace '\{\{title\}\}', $Title
$content = [regex]::Replace($content, '\{\{date:([^}]+)\}\}', { param($m2) (Get-Date).ToString($m2.Groups[1].Value) })
$content = [regex]::Replace($content, '\{\{time:([^}]+)\}\}', { param($m2) (Get-Date).ToString($m2.Groups[1].Value) })
$content = $content -replace '\{\{date\}\}', (Get-Date -Format 'yyyy-MM-dd') -replace '\{\{time\}\}', (Get-Date -Format 'HH:mm:ss')

[System.IO.File]::WriteAllText($dest, $content, (New-Object System.Text.UTF8Encoding($false)))
"CREATED=$dest"

if (-not $NoSync) { & (Join-Path $PSScriptRoot 'sync.ps1') -Message "new-note: $safe" }
