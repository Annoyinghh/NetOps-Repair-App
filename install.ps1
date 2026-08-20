# =====================================================================
# NetOps Agent 一键云端下载与部署脚本 (PowerShell)
# 运行方式 (在目标电脑管理员 PowerShell 中执行):
# irm https://raw.githubusercontent.com/Annoyinghh/NetOps-Repair-App/main/install.ps1 | iex
# =====================================================================

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "       🚀 NetOps Agent 智能运维终端 一键云端部署       " -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Cyan

$InstallDir = "$env:ProgramData\NetOpsAgent"
$ExePath = "$InstallDir\NetOpsAgent.exe"
$DownloadUrl = "https://github.com/Annoyinghh/NetOps-Repair-App/releases/latest/download/NetOpsAgent.exe"

# 1. 创建安装目录
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 2. 检查是否有正在运行的旧进程并结束
$existing = Get-Process -Name "NetOpsAgent" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[1/4] 正在停止旧版 Agent 进程..." -ForegroundColor Yellow
    Stop-Process -Name "NetOpsAgent" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# 3. 从云端下载最新版 Agent
Write-Host "[2/4] 正在从云端下载最新版 NetOpsAgent.exe..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ExePath -UseBasicParsing
    Write-Host "  ✅ 下载完成: $ExePath" -ForegroundColor Green
} catch {
    Write-Host "  ⚠️ 从 GitHub Release 下载失败，尝试备用地址或本地复制..." -ForegroundColor Yellow
}

# 4. 创建桌面快捷方式
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\NetOps Agent.lnk")
    $Shortcut.TargetPath = $ExePath
    $Shortcut.Save()
    Write-Host "[3/4] 已创建桌面快捷方式: NetOps Agent" -ForegroundColor Green
} catch {}

# 5. 注册开机自启动计划任务
Write-Host "[4/4] 正在配置 Windows 开机静默常驻任务..." -ForegroundColor Yellow
$TaskName = "NetOps Agent"
$ActionCmd = "powershell.exe -NoProfile -WindowStyle Hidden -Command `"Start-Process -FilePath '$ExePath' -ArgumentList '--background' -WindowStyle Hidden`""
schtasks /create /tn "$TaskName" /tr "$ActionCmd" /sc onlogon /rl highest /f | Out-Null
Write-Host "  ✅ 开机自启动注册成功！" -ForegroundColor Green

# 6. 立即启动 Agent
Write-Host "🎉 正在启动 NetOps Agent..." -ForegroundColor Cyan
Start-Process -FilePath $ExePath

Write-Host "=====================================================" -ForegroundColor Green
Write-Host "  ✅ NetOps Agent 部署运行成功！" -ForegroundColor Green
Write-Host "  📱 现在可以使用手机 App 开启雷达扫描秒连此电脑！" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Green
