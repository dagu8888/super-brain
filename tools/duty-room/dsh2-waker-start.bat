@echo off
REM DSH2 waker starter (task #285) - auto start entry
REM Credentials: user env var SB_VIEWER_TOKEN only (shared with dsh2-courier)
REM Never store tokens in this file. No token -> log and exit (no restart loop)
set PYTHONIOENCODING=utf-8
if "%SB_VIEWER_TOKEN%"=="" (
  echo %date% %time% missing SB_VIEWER_TOKEN, waker not started >> "%USERPROFILE%\dsh2-waker.log"
  exit /b 2
)
cd /d "D:\DSH\super-brain\tools\duty-room"
:loop
python dsh2-waker.py >> "%USERPROFILE%\dsh2-waker-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
