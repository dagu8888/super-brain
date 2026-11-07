# setup-task.ps1 — 注册/卸载每日与每周自动索引计划任务
# 用法：setup-task.ps1（注册）  setup-task.ps1 -Remove（卸载）
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$daily = 'DSH-KB-Daily-Index'
$weekly = 'DSH-KB-Weekly-Index'
$batDaily = 'D:\DSH\Yuan Ai\super-brain\scripts\auto-index-daily.bat'
$batWeekly = 'D:\DSH\Yuan Ai\super-brain\scripts\auto-index-weekly.bat'

if ($Remove) {
  schtasks /delete /tn $daily /f 2>$null
  schtasks /delete /tn $weekly /f 2>$null
  'TASKS_REMOVED'
  return
}

if (-not (Test-Path $batDaily)) { throw "缺少 $batDaily" }
schtasks /create /tn $daily /tr "`"$batDaily`"" /sc DAILY /st 23:30 /f | Out-Null
schtasks /create /tn $weekly /tr "`"$batWeekly`"" /sc WEEKLY /d SUN /st 22:00 /f | Out-Null
schtasks /query /tn $daily | Out-String
schtasks /query /tn $weekly | Out-String
'TASKS_CREATED'
