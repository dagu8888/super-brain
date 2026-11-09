@echo off
REM DSH一号@主机 节点信使启动器（开机自启入口）
REM 凭据从 %USERPROFILE%\.dsh1-courier.json 读取，不写入本文件
cd /d "D:\DSH\Yuan Ai\super-brain\tools\duty-room"
set PYTHONIOENCODING=utf-8
:loop
python dsh1-courier.py >> "%USERPROFILE%\dsh1-courier-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
