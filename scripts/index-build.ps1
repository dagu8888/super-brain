# index-build.ps1 — 每日/每周自动索引与图谱统计（输出到 99-Meta/INDEX 与 99-Meta/周报）
# 兼容 Windows PowerShell 5.1（需 UTF-8 BOM）；全文件不使用反引号
param(
  [switch]$Weekly,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$idxDir = Join-Path $root '99-Meta\INDEX'
$weekDir = Join-Path $root '99-Meta\周报'
New-Item -ItemType Directory -Force $idxDir, $weekDir | Out-Null

$topDirs = '00-Inbox','10-Projects','20-Areas','30-Resources','40-Archives','50-Skills','60-Daily'
$all = Get-ChildItem $root -Recurse -Filter *.md -File |
  Where-Object { $_.FullName -notmatch '\\(\.obsidian|\.trash|99-Meta\\INDEX|99-Meta\\周报)\\' -and $_.FullName -notmatch '\\99-Meta\\[^\\]+\.md$' -and $_.DirectoryName -notlike '*90-Templates*' -and $_.Name -ne 'README.md' -and $_.Name -ne 'AGENTS.md' }
$now = Get-Date
$stamp = $now.ToString('yyyy-MM-dd HH:mm:ss')

function RelPath($f) {
  return (($f.FullName.Substring($root.Length + 1)) -replace '\\', '/' -replace '\.md$', '')
}

function Fm($f) {
  $head = @(Get-Content $f.FullName -TotalCount 20 -Encoding UTF8 -ErrorAction SilentlyContinue)
  $title = $null; $tagsLine = $null
  foreach ($l in $head) {
    if (-not $title -and $l -match '^title:\s*"?([^"]+)"?') { $title = $Matches[1] }
    if (-not $tagsLine -and $l -match '^tags:\s*\[(.*)\]') { $tagsLine = $Matches[1] }
  }
  if (-not $title) { $title = $f.BaseName }
  $tags = @()
  if ($tagsLine) { $tags = @($tagsLine -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  return [pscustomobject]@{ File = $f; Title = $title; Tags = $tags }
}

function WriteUtf8($path, $lines) {
  [System.IO.File]::WriteAllLines($path, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

# ── 1) INDEX-最近更新 TOP50 ─────────────────────────────
$rec = @($all | Sort-Object LastWriteTime -Descending | Select-Object -First 50)
$lines = @('---','id: index-recent','title: 最近更新 TOP50',('updated: ' + $stamp),'tags: [索引, 自动生成]','---','','# 最近更新 TOP50','','| 笔记 | 目录 | 更新时间 |','|---|---|---|')
foreach ($f in $rec) {
  $top = $f.FullName.Substring($root.Length + 1).Split('\')[0]
  $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
  $lines += ('| [[/' + (RelPath $f) + '|' + $name + ']] | ' + $top + ' | ' + $f.LastWriteTime.ToString('MM-dd HH:mm') + ' |')
}
WriteUtf8 (Join-Path $idxDir 'INDEX-最近更新.md') $lines

# ── 2) INDEX-标签 ────────────────────────────────────────
$tagMap = @{}
foreach ($f in $all) { $p = Fm $f; foreach ($t in $p.Tags) {
  if (-not $tagMap.ContainsKey($t)) { $tagMap[$t] = @() }
  $tagMap[$t] += $p
} }
$lines = @('---','id: index-tags','title: 标签索引',('updated: ' + $stamp),'tags: [索引, 自动生成]','---','','# 标签索引','')
foreach ($t in ($tagMap.Keys | Sort-Object)) {
  $lines += ('## #' + $t + ' (' + (@($tagMap[$t]).Count) + ')')
  foreach ($p in $tagMap[$t]) { $lines += ('- [[/' + (RelPath $p.File) + '|' + $p.Title + ']]') }
  $lines += ''
}
WriteUtf8 (Join-Path $idxDir 'INDEX-标签.md') $lines

# ── 3) INDEX-全目录 ─────────────────────────────────────
$lines = @('---','id: index-folders','title: 全目录索引',('updated: ' + $stamp),'tags: [索引, 自动生成]','---','','# 全目录索引','')
foreach ($d in $topDirs) {
  $files = @($all | Where-Object { $_.FullName.StartsWith((Join-Path $root $d)) })
  $lines += ('## ' + $d + ' (' + $files.Count + ')')
  foreach ($f in ($files | Sort-Object Name)) { $lines += ('- [[/' + (RelPath $f) + '|' + [IO.Path]::GetFileNameWithoutExtension($f.Name) + ']]') }
  $lines += ''
}
WriteUtf8 (Join-Path $idxDir 'INDEX-全目录.md') $lines

# ── 4) 图谱统计 + 孤立笔记 ──────────────────────────────
$refs = @{}
$linkCount = 0
foreach ($f in $all) {
  $txt = Get-Content $f.FullName -Raw -Encoding UTF8
  if ($txt) {
    foreach ($m in [regex]::Matches($txt, '\[\[([^\]|#]+)')) {
      $name = $m.Groups[1].Value.Trim()
      $linkCount++
      $refs[$name] = @($refs[$name]) + $f.BaseName
    }
  }
}
$allFm = @($all | ForEach-Object { Fm $_ })
$orphans = @($allFm | Where-Object { $_.File.BaseName -notin @('index','MOC-总索引') -and -not $refs.ContainsKey($_.File.BaseName) })
$lines = @('---','id: index-graph','title: 图谱统计',('updated: ' + $stamp),'tags: [索引, 自动生成]','---','',
  '# 图谱统计','',
  ('- 笔记总数：' + $all.Count),
  ('- 双链总数：' + $linkCount),
  ('- 标签数：' + $tagMap.Count),
  ('- 孤立笔记：' + $orphans.Count),'')
$topRef = @($refs.GetEnumerator() | Sort-Object { @($_.Value).Count } -Descending | Select-Object -First 10)
if ($topRef.Count -gt 0) {
  $lines += '## 被引用最多',''
  foreach ($r in $topRef) { $lines += ('- ' + $r.Key + ' × ' + @($r.Value).Count) }
  $lines += ''
}
WriteUtf8 (Join-Path $idxDir 'INDEX-图谱统计.md') $lines

$lines = @('---','id: index-orphans','title: 孤立笔记',('updated: ' + $stamp),'tags: [索引, 自动生成]','---','',
  '# 孤立笔记（无任何入链）','','> 处理：链回 [[MOC-总索引]] 或归档 40-Archives。','')
foreach ($o in $orphans) { $lines += ('- [[/' + (RelPath $o.File) + '|' + $o.Title + ']]') }
WriteUtf8 (Join-Path $idxDir '孤立笔记.md') $lines

# ── 5) 周报（-Weekly 或周日自动） ───────────────────────
$weeklyMsg = '非周报日'
if ($Weekly -or $now.DayOfWeek -eq [System.DayOfWeek]::Sunday) {
  $cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
  $weekNum = $cal.GetWeekOfYear($now, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [System.DayOfWeek]::Monday)
  $week = $now.ToString('yyyy') + '-W' + ('{0:d2}' -f $weekNum)
  $since = $now.AddDays(-7)
  $newNotes = @($all | Where-Object { $_.CreationTime -ge $since })
  $updNotes = @($all | Where-Object { $_.LastWriteTime -ge $since })
  $lines = @('---',('id: weekly-' + $week),('title: 周报 ' + $week),('created: ' + $stamp),'tags: [周报, 自动生成]','status: evergreen','---','',
    ('# 周报 ' + $week),'',
    ('- 新增笔记：' + $newNotes.Count + '　更新笔记：' + $updNotes.Count),'','## 本周新增','')
  foreach ($f in $newNotes) { $lines += ('- [[/' + (RelPath $f) + '|' + [IO.Path]::GetFileNameWithoutExtension($f.Name) + ']]（' + $f.CreationTime.ToString('MM-dd') + '）') }
  $lines += '','## 本周更新（非新增）',''
  foreach ($f in ($updNotes | Where-Object { $_.CreationTime -lt $since })) { $lines += ('- [[/' + (RelPath $f) + '|' + [IO.Path]::GetFileNameWithoutExtension($f.Name) + ']]（' + $f.LastWriteTime.ToString('MM-dd HH:mm') + '）') }
  WriteUtf8 (Join-Path $weekDir ('周报-' + $week + '.md')) $lines
  $weeklyMsg = '周报 ' + $week + ' 已生成'
}

if (-not $Quiet) {
  'INDEX_OK=笔记 ' + $all.Count + ' 条 | 双链 ' + $linkCount + ' 条 | 标签 ' + $tagMap.Count + ' 个 | 孤立 ' + $orphans.Count + ' 条 | ' + $weeklyMsg
} else {
  'INDEX_OK'
}
