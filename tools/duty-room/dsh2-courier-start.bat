@echo off
REM dsh2-courier starter - presence heartbeat only (ASCII only, no UTF-8!)
REM Credentials: user env var SB_VIEWER_TOKEN from HKCU\Environment (never stored in this file)
set "TOKEN="
for /f "tokens=2,* delims= " %%A in ('reg query "HKCU\Environment" /v SB_VIEWER_TOKEN 2^>nul ^| find "SB_VIEWER_TOKEN"') do set "TOKEN=%%B"
if not defined TOKEN (
  echo %date% %time% missing SB_VIEWER_TOKEN in HKCU\Environment, courier not started >> "%USERPROFILE%\dsh2-courier.log"
  exit /b 2
)
set "SB_VIEWER_TOKEN=%TOKEN%"
cd /d "D:\DSH\super-brain\tools\duty-room"
set PYTHONIOENCODING=utf-8
python dsh2-courier.py --once >> "%USERPROFILE%\dsh2-courier-stdout.log" 2>&1
if errorlevel 2 goto notoken
:loop
python dsh2-courier.py >> "%USERPROFILE%\dsh2-courier-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
:notoken
echo %date% %time% courier missing viewer token, heartbeat not started >> "%USERPROFILE%\dsh2-courier-stdout.log"
