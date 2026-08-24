@echo off
chcp 65001 >nul
wmic process call create "%USERPROFILE%\Desktop\NetOpsAgent.exe" >nul 2>&1
echo [NetOps] Agent 已成功在 Windows 系统后台独立运行！
timeout /t 2 >nul
