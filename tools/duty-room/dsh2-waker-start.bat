@echo off
REM dsh2-waker starter (task #285) - auto start entry (ASCII only, no UTF-8!)
REM Credentials: user env var SB_VIEWER_TOKEN from HKCU\Environment (never stored in this file)
set "TOKEN="
for /f "tokens=2,* delims= " %%A in ('reg query "HKCU\Environment" /v SB_VIEWER_TOKEN 2^>nul ^| find "SB_VIEWER_TOKEN"') do set "TOKEN=%%B"
if not defined TOKEN (
  echo %date% %time% missing SB_VIEWER_TOKEN in HKCU\Environment, waker not started >> "%USERPROFILE%\dsh2-waker.log"
  exit /b 2
)
set "SB_VIEWER_TOKEN=%TOKEN%"
cd /d "D:\DSH\super-brain\tools\duty-room"
set PYTHONIOENCODING=utf-8
:loop
python dsh2-waker.py >> "%USERPROFILE%\dsh2-waker-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
