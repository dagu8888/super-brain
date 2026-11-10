# Super-Brain 节点桥看门狗（Windows）
# 职责：进程不在就拉起 agent-bridge.py；可注册为计划任务（开机 + 每 2 分钟）。
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File .\watchdog.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File .\watchdog.ps1 -Uninstall
# 不在命令行里放置口令。口令走用户环境变量 SUPERBRAIN_GATEWAY_TOKEN。
param(
    [switch]$Install,
    [switch]$Uninstall,
    [string]$TaskName = "SuperBrain-AgentBridge",
    [string]$Python = $env:SB_PYTHON
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $Here "agent-bridge.py"
$Log = Join-Path $Here "bridge.log"
$Config = Join-Path $Here "agent-bridge.json"

function Write-Log([string]$msg) {
    $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $msg
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "已删除计划任务 $TaskName"
    exit 0
}

if ($Install) {
    if (-not (Test-Path $Bridge)) { throw "找不到 $Bridge" }
    $ps = (Get-Command powershell).Source
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    $action = New-ScheduledTaskAction -Execute $ps -Argument $args -WorkingDirectory $Here
    $t1 = New-ScheduledTaskTrigger -AtLogOn
    $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Settings $settings -Force | Out-Null
    Write-Output "已注册计划任务 $TaskName（登录时 + 每 2 分钟巡检）"
    exit 0
}

if (-not (Test-Path $Bridge)) {
    Write-Log "WATCHDOG 找不到 agent-bridge.py"
    exit 2
}
if (-not (Test-Path $Config)) {
    Write-Log "WATCHDOG 找不到 agent-bridge.json，请先复制 example 并填写"
    exit 2
}

$running = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='py.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "agent-bridge\.py" }

if ($running) {
    exit 0
}

if (-not $Python) {
    $cmd = Get-Command py, python, pythonw -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        Write-Log "WATCHDOG 找不到 Python"
        exit 2
    }
    $Python = $cmd.Source
}

Write-Log "WATCHDOG 拉起节点桥  python=$Python"
$p = Start-Process -FilePath $Python -ArgumentList @($Bridge) -WorkingDirectory $Here -WindowStyle Hidden -PassThru
Write-Log "WATCHDOG 已启动 pid=$($p.Id)"
