@echo off
cd /d "D:\DSH\Yuan Ai\super-brain"
pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\index-build.ps1" -Weekly -Quiet
pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\sync.ps1" -Message "chore: 每周自动周报"
