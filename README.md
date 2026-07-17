# NetOps Repair — 智能运维助手

基于手机端控制的 Windows 主机智能自检、网络修复与系统运维管理系统。通过手机（USB 数据线 / Wi-Fi / 蓝牙）即可远程操控，无需在电脑端进行任何手动操作，即可完成系统完整性修复、网络故障自愈、进程服务管理及自动化资产巡检。

---

## 项目结构

```
netops-repair/
├── ops-helper/                 # 手机控制端 App（React Native + Expo SDK 57）
│   ├── App.js                   # 主应用（6 大 Tab 功能卡片）
│   ├── modules/usb-agent/       # USB 自动部署 Agent 的原生模块（Kotlin）
│   ├── assets/agent/            # NetOpsAgent.exe 二进制文件（内置到 APK）
│   ├── android/                 # 原生 Android 构建产物
│   └── src/adb/                 # ADB 辅助工具
├── src/
│   ├── pc-agent/                # PC Agent 开发版源码（Node.js）
│   └── pc-agent-standalone/     # PC Agent 独立打包版源码 → 编译为 NetOpsAgent.exe
├── sandbox/                     # Docker 沙盒部署环境
│   ├── Dockerfile.agent
│   └── docker-compose.yml
└── README.md
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 手机控制端 | React Native + Expo SDK 57 (React Native 0.86) |
| 通信协议 | WebSocket（实时遥测 + 指令分发）+ HTTP 流（补丁推送 / 报表下载） |
| PC 被控端 | Node.js WebSocket 守护进程，编译为 `NetOpsAgent.exe` |
| 系统调用 | `child_process` 管道调用 `wmic`、`powershell`、`netsh`、`sfc`、`dism`、`chkdsk` |
| USB 部署 | Expo 原生模块（Kotlin），通过 ADB 自动推送 Agent 到电脑并启动 |
| 沙盒 | Docker & Docker Compose |

## 功能概览

1. **资产巡检** — 自动收集主机名、MAC、IP、CPU、RAM、磁盘、显卡，扫描已安装应用与系统补丁
2. **硬件监控** — 每 3 秒实时推送 CPU / 内存 / 磁盘负载，支持进程强制终止与 Windows 服务管理
3. **网络与安全** — 外网 Ping、DNS、网关诊断，防火墙策略分发，本地账户管理
4. **一键自愈** — 网络重置（DNS / TCP/IP / Winsock）、系统修复（SFC / DISM）、性能优化
5. **远程与文件** — 远程 Shell 终端、文件推送、事件日志一键归档
6. **自动巡检报表** — 一键评估硬件健康度，生成 UTF-8 BOM 兼容的 CSV 报表

## 快速开始

App 启动后会自动检测连接方式：

- **USB 数据线** — App 通过 `usb-agent` 原生模块检测 USB 设备，提取内置的 `NetOpsAgent.exe` 和 ADB 工具链，通过 ADB 推送到电脑并自动启动，零手动操作
- **Wi-Fi 局域网** — 确保手机与电脑在同一网络，App 自动扫描并连接 Agent
- **蓝牙** — 手机与电脑配对后，App 通过蓝牙 RFCOMM 通道连接

### 连接流程（USB 模式）

```
手机插入 USB → App 检测设备 → 请求 USB 权限
    → 提取 NetOpsAgent.exe + ADB 工具
    → adb push 到电脑临时目录
    → adb shell 启动 Agent
    → Agent 监听 3001 端口
    → 手机建立 WebSocket 连接 → 开始控制
```

> 沙盒模式（Docker）：
> ```bash
> cd sandbox
> docker-compose up --build
> ```

## 打包 APK

项目已配置本地 JKS 签名与 `eas.json` 的 `preview` profile。打包前需编译 Agent 并登录 Expo：

```powershell
# 1. 编译 NetOpsAgent.exe
cd src\pc-agent-standalone
npm install
npx pkg . --targets node18-win-x64 --output NetOpsAgent.exe
copy NetOpsAgent.exe ..\..\ops-helper\assets\agent\

# 2. 登录 Expo 并构建
npx eas-cli login
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
npx eas-cli build -p android --profile preview
```

> 编译 Agent 需要安装 `@yao-pkg/pkg`，ADB 工具链需从 Android SDK Platform-Tools 下载并放入 `ops-helper/assets/tools/`。

## 许可

MIT License © 2025 Xu Zhixuan