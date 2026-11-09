@echo off
REM DSH二号@笔记本 在场心跳启动器（开机自启入口）
REM 机制修正（2026-11-09）：信使只有一份、跑在服务器里；本机只挂在场心跳长连接。
REM 凭据从 %USERPROFILE%\.dsh2-courier.json 或环境变量 SB_VIEWER_TOKEN 读取，不写入本文件。
REM 凭据未到位时不进入重启循环（避免每 10s 空转刷日志），到位后下次触发即常驻。
cd /d "D:\DSH\super-brain\tools\duty-room"
set PYTHONIOENCODING=utf-8
python dsh2-courier.py --once >> "%USERPROFILE%\dsh2-courier-stdout.log" 2>&1
if errorlevel 2 goto notoken
:loop
python dsh2-courier.py >> "%USERPROFILE%\dsh2-courier-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
:notoken
echo [%date% %time%] 缺少 viewers 口令，在场心跳未启动；凭据交付后重新运行本脚本即可。 >> "%USERPROFILE%\dsh2-courier-stdout.log"
