@echo off
:: Check for Administrator privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :admin
) else (
    echo ==============================================
    echo 警告: 该安装脚本必须以管理员身份运行！
    echo 请右键选择 "以管理员身份运行" 本脚本。
    echo ==============================================
    pause
    exit /b
)

:admin
set AGENT_PATH=D:\Project\netops-repair\src\pc-agent
set SCRIPT_PATH=%AGENT_PATH%\index.js

echo [NetOps] 正在将 PC Agent 配置为 Windows 系统开机静默启动服务...

:: Delete old task if exists
schtasks /delete /tn "WindowsNetOpsAgent" /f >nul 2>&1

:: Create a scheduled task that runs silently under SYSTEM account at system startup
:: This runs in the session 0 background, completely invisible (no command windows)
schtasks /create /tn "WindowsNetOpsAgent" /tr "node %SCRIPT_PATH%" /sc onstart /ru "SYSTEM" /rl highest /f

if %errorLevel% == 0 (
    echo ==============================================
    echo 成功: Windows 静默后台自启服务安装成功！
    echo 现在您可以关闭此窗口。
    echo 电脑以后每次开机都会在后台自动默默启动该运维通道。
    echo ==============================================
    
    :: Immediately start the background service now
    echo 正在启动后台服务...
    schtasks /run /tn "WindowsNetOpsAgent"
) else (
    echo 失败: 后台服务创建失败，请检查 Node.js 路径。
)
pause
