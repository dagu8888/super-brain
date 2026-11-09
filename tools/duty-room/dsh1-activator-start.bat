@echo off
REM DSH1@host duty activator launcher (boot entry, same pattern as dsh1-courier-start.bat)
REM Chief token is read from user env var SB_TOKEN. Never stored in this file.
cd /d "D:\DSH\Yuan Ai\super-brain\tools\duty-room"
set PYTHONIOENCODING=utf-8
:loop
python dsh1-activator.py >> "%USERPROFILE%\dsh1-activator-stdout.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
