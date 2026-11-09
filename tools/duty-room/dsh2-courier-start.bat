@echo off
REM DSH二号@笔记本 节点信使启动器（开机自启入口）
REM 与 dsh1-courier-start.bat 同一套；凭据从 %USERPROFILE%\.dsh2-courier.json
REM 或环境变量 SB_VIEWER_TOKEN 读取，不写入本文件。
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
echo [%date% %time%] 缺少 viewers 口令，信使未启动；凭据交付后重新运行本脚本即可。 >> "%USERPROFILE%\dsh2-courier-stdout.log"
