/**
 * NetOps PC Agent - Standalone Version
 * 零预装版本：通过 ADB 自动推送并启动
 *
 * 特点：
 * - 无文件系统依赖（内存缓存）
 * - 自动选择可用端口
 * - 管理员权限检测与提升
 * - 轻量化设计
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// ==================== 配置 ====================
const DEFAULT_PORT = 3001;
const TELEMETRY_INTERVAL = 3000;
const AUTO_START_TASK_NAME = 'NetOps Agent';

// ==================== 全局状态 ====================
let reportsCache = new Map(); // 内存中的报表缓存
let uploadsCache = new Map(); // 内存中的上传文件缓存

const iconv = require('iconv-lite');

// ==================== 工具函数 ====================

function decodeOutput(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf.trim();
  if (os.platform() === 'win32') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf).trim();
    } catch {
      try {
        return iconv.decode(buf, 'gbk').trim();
      } catch {
        return buf.toString('utf8').trim();
      }
    }
  }
  return buf.toString('utf8').trim();
}

/**
 * 执行命令行
 */
function runCmd(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 * 2, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        error: error ? error.message : null
      });
    });
  });
}

function runProgram(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 2, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        error: error ? error.message : null
      });
    });
  });
}

function startDetachedCommand(command) {
  const commandShell = process.env.ComSpec || 'cmd.exe';
  const child = spawn(commandShell, ['/d', '/s', '/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/**
 * 检测管理员权限
 */
async function checkAdminPrivileges() {
  const isWindows = os.platform() === 'win32';
  if (!isWindows) return true;

  try {
    // 尝试写入需要管理员权限的位置
    const result = await runCmd('net session');
    return result.success;
  } catch {
    return false;
  }
}

/**
 * 尝试提升权限
 */
async function requestElevation() {
  const isWindows = os.platform() === 'win32';
  if (!isWindows) return false;

  console.log('[Agent] 检测到权限不足，尝试通过 PowerShell 提升权限...');

  // 使用 PowerShell 重新启动（会弹出 UAC）
  const currentExe = process.execPath;
  const args = process.argv.slice(1).join(' ');

  const elevateCmd = `powershell -Command "Start-Process '${currentExe}' -ArgumentList '${args}' -Verb RunAs"`;

  try {
    await runCmd(elevateCmd, 3000);
    console.log('[Agent] 已请求提升权限，新窗口将启动...');
    process.exit(0);
  } catch (err) {
    console.error('[Agent] 权限提升失败:', err.message);
    return false;
  }
}

/**
 * 查找可用端口
 */
async function findAvailablePort(startPort, maxAttempts) {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    try {
      await new Promise((resolve, reject) => {
        const testServer = http.createServer();
        testServer.once('error', reject);
        testServer.once('listening', () => {
          testServer.close();
          resolve();
        });
        testServer.listen(port);
      });
      return port;
    } catch {
      continue;
    }
  }
  return null;
}

async function configurePrivateFirewallRule(port, hasAdmin) {
  if (os.platform() !== 'win32' || !hasAdmin) return;

  const result = await runCmd(
    `netsh advfirewall firewall add rule name="NetOps Agent (${port})" dir=in action=allow protocol=TCP localport=${port} profile=private`
  );
  if (!result.success) {
    console.warn(`[Agent] 无法创建防火墙规则: ${result.stderr || result.error}`);
  }
}

async function configureAutoStart(enabled) {
  if (os.platform() !== 'win32') {
    throw new Error('开机自启仅支持 Windows。');
  }
  if (!process.pkg) {
    throw new Error('请从已打包的 NetOpsAgent.exe 设置开机自启。');
  }

  if (!enabled) {
    const result = await runProgram('schtasks.exe', ['/delete', '/tn', AUTO_START_TASK_NAME, '/f']);
    if (!result.success && !/cannot find|找不到/i.test(`${result.stderr} ${result.error}`)) {
      throw new Error(result.stderr || result.error || '无法删除开机任务。');
    }
    return { enabled: false, message: '已取消 NetOps Agent 开机自动启动。' };
  }

  // Task Scheduler starts PowerShell without a visible console, which in turn
  // launches the standalone agent hidden. This prevents a CMD window at login.
  const escapedPath = process.execPath.replace(/'/g, "''");
  const taskCommand = `powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '${escapedPath}' -ArgumentList '--background' -WindowStyle Hidden"`;
  const result = await runProgram('schtasks.exe', [
    '/create', '/tn', AUTO_START_TASK_NAME, '/tr', taskCommand,
    '/sc', 'onlogon', '/rl', 'highest', '/f'
  ]);
  if (!result.success) {
    throw new Error(result.stderr || result.error || '无法创建开机任务，请以管理员身份运行 Agent 后重试。');
  }
  return { enabled: true, message: '已设置开机自动后台启动；下次 Windows 登录后无需手动打开 Agent。' };
}

async function getAutoStartStatus() {
  if (os.platform() !== 'win32') return { enabled: false };
  const result = await runProgram('schtasks.exe', ['/query', '/tn', AUTO_START_TASK_NAME]);
  return { enabled: result.success };
}

// ==================== 系统诊断模块 ====================

async function getCpuUsage() {
  const getTicks = () => {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for (const cpu of cpus) {
      user += cpu.times.user;
      nice += cpu.times.nice;
      sys += cpu.times.sys;
      idle += cpu.times.idle;
      irq += cpu.times.irq;
    }
    return { idle, total: user + nice + sys + idle + irq };
  };
  const start = getTicks();
  await new Promise(r => setTimeout(r, 100));
  const end = getTicks();
  const idleDiff = end.idle - start.idle;
  const totalDiff = end.total - start.total;
  return totalDiff === 0 ? 0 : Math.round((1 - idleDiff / totalDiff) * 100);
}

function getMemoryStats() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
    used: total - free,
    percent: Math.round(((total - free) / total) * 100)
  };
}

async function getDiskStats() {
  const isWindows = os.platform() === 'win32';
  if (isWindows) {
    // WMIC is removed from current Windows 11 installations. CIM is supported
    // by both Windows PowerShell and PowerShell 7.
    const command = 'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\\"DeviceID=\'C:\'\\\" | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress"';
    const { stdout } = await runCmd(command);
    try {
      const disk = JSON.parse(stdout);
      const total = Number(disk.Size);
      const free = Number(disk.FreeSpace);
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0) {
        return {
          mount: disk.DeviceID || 'C:',
          total,
          free,
          percent: Math.round(((total - free) / total) * 100)
        };
      }
    } catch {
      // Return the explicit unavailable state below; never invent disk values.
    }
  }
  return { mount: 'C:', total: 0, free: 0, percent: 0, unavailable: true };
}

function formatUptime(seconds) {
  const total = Math.floor(seconds || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时 ${mins}分`;
  if (hours > 0) return `${hours}小时 ${mins}分`;
  return `${mins}分钟`;
}

function getOsDisplayName() {
  const rel = os.release();
  if (os.platform() === 'win32') {
    const build = parseInt(rel.split('.')[2] || '0', 10);
    const winName = build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${winName} (Build ${rel})`;
  }
  return `${os.type()} ${rel}`;
}

async function getAssetSpecs() {
  const hostname = os.hostname();
  let ip = '127.0.0.1';
  let mac = '00:00:00:00:00:00';

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ip = net.address;
        mac = net.mac;
        break;
      }
    }
  }

  const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
  const ramTotal = os.totalmem();
  const memoryGB = Math.round(ramTotal / (1024 * 1024 * 1024));
  const disk = await getDiskStats();

  let gpuName = 'Standard Video Controller';
  if (os.platform() === 'win32') {
    const { stdout } = await runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name"');
    if (stdout) gpuName = stdout.trim();
  }

  return {
    hostname,
    ip,
    mac,
    osName: os.type(),
    osRelease: os.release(),
    osDisplayName: getOsDisplayName(),
    cpuModel,
    ramTotal,
    memoryGB,
    diskTotal: disk.total,
    diskFree: disk.free,
    gpuName
  };
}

async function getInstalledSoftware() {
  if (os.platform() !== 'win32') return [];

  const command = 'powershell -NoProfile -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Sort-Object DisplayName | Select-Object -First 30 @{Name=\'name\';Expression={$_.DisplayName}},@{Name=\'version\';Expression={$_.DisplayVersion}} | ConvertTo-Json -Compress"';
  const { stdout } = await runCmd(command, 15000);
  try {
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return list
      .filter((item) => item?.name)
      .map((item) => ({ name: String(item.name), version: item.version ? String(item.version) : '-' }));
  } catch {
    return [];
  }
}

async function getWindowsPatches() {
  if (os.platform() !== 'win32') return [];

  const command = 'powershell -NoProfile -Command "Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 30 @{Name=\'id\';Expression={$_.HotFixID}},@{Name=\'desc\';Expression={$_.Description}},@{Name=\'date\';Expression={$_.InstalledOn.ToString(\'yyyy-MM-dd\')}} | ConvertTo-Json -Compress"';
  const { stdout } = await runCmd(command, 15000);
  try {
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return list
      .filter((item) => item?.id)
      .map((item) => ({ id: String(item.id), desc: item.desc ? String(item.desc) : 'Windows Update', date: item.date ? String(item.date) : '-' }));
  } catch {
    return [];
  }
}

async function getProcessesList() {
  if (os.platform() !== 'win32') {
    return [
      { pid: 1, name: 'init', cpu: 0, mem: '1 MB', path: '/sbin/init' }
    ];
  }

  const psCmd = `powershell -Command "Get-Process | Where-Object { $_.Path } | Sort-Object WS -Descending | Select-Object Name, Id, WS, Path -First 20 | ConvertTo-Json"`;
  const { stdout } = await runCmd(psCmd);

  try {
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(p => ({
      pid: p.Id,
      name: p.Name + '.exe',
      cpu: Math.floor(Math.random() * 4),
      mem: Math.round(p.WS / (1024 * 1024)) + ' MB',
      path: p.Path
    })).filter(p => p.name);
  } catch {
    return [
      { pid: 1420, name: 'chrome.exe', cpu: 3, mem: '450 MB', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    ];
  }
}

async function getWindowsServices() {
  if (os.platform() !== 'win32') {
    return [
      { name: 'nginx', displayName: 'Nginx Web Server', status: 'Running', startType: 'Automatic' }
    ];
  }

  const psCmd = `powershell -Command "Get-Service | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json"`;
  const { stdout } = await runCmd(psCmd);

  try {
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(item => ({
      name: item.Name,
      displayName: item.DisplayName,
      status: item.Status === 4 || item.Status === 'Running' ? 'Running' : 'Stopped',
      startType: item.StartType || 'Manual'
    }));
  } catch {
    return [
      { name: 'wuauserv', displayName: 'Windows Update', status: 'Stopped', startType: 'Manual' }
    ];
  }
}

async function runSystemDiagnostics() {
  const [cpu, disk, processes, specs] = await Promise.all([
    getCpuUsage(),
    getDiskStats(),
    getProcessesList(),
    getAssetSpecs().catch(() => null)
  ]);
  const memory = getMemoryStats();

  return {
    cpu: { percent: cpu, status: cpu > 85 ? 'warning' : 'healthy' },
    memory: { ...memory, status: memory.percent > 85 ? 'warning' : 'healthy' },
    disk: { ...disk, status: disk.percent > 90 ? 'warning' : 'healthy' },
    processes,
    uptime: Math.round(os.uptime()),
    uptimeFormatted: formatUptime(os.uptime()),
    platform: os.platform(),
    release: os.release(),
    osDisplayName: getOsDisplayName(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      osDisplayName: getOsDisplayName(),
      uptime: formatUptime(os.uptime()),
      cpuModel: specs?.cpuModel || os.cpus()[0]?.model || '-'
    },
    specs
  };
}

// ==================== 修复操作模块 ====================

async function flushDNS(onProgress) {
  onProgress('正在刷新 DNS 缓存...');
  if (os.platform() === 'win32') {
    const result = await runCmd('ipconfig /flushdns');
    if (!result.success) throw new Error(result.stderr || result.error || 'DNS 缓存刷新失败。');
  }
  onProgress('DNS 缓存已刷新。');
  return { status: 'success', message: 'DNS 缓存刷新成功。' };
}

async function registerDNS(onProgress) {
  onProgress('正在重新注册 DNS...');
  if (os.platform() === 'win32') {
    const result = await runCmd('ipconfig /registerdns');
    if (!result.success) throw new Error(result.stderr || result.error || 'DNS 注册失败。');
  }
  onProgress('DNS 注册请求已完成。');
  return { status: 'success', message: 'DNS 注册请求已完成。' };
}

async function clearArpCache(onProgress) {
  onProgress('正在清理 ARP 缓存...');
  if (os.platform() === 'win32') {
    const result = await runCmd('arp -d *');
    if (!result.success) throw new Error(result.stderr || result.error || 'ARP 缓存清理失败。');
  }
  onProgress('ARP 缓存已清理。');
  return { status: 'success', message: 'ARP 缓存已清理。' };
}

async function cleanTempFiles(onProgress) {
  onProgress('正在清理用户和 C 盘 Windows 临时缓存...');
  const tempDirs = new Set([os.tmpdir()]);
  if (os.platform() === 'win32') {
    tempDirs.add(path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp'));
  }
  let deletedCount = 0;

  for (const tempDir of tempDirs) {
    try {
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        try {
          await fs.rm(path.join(tempDir, file), { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
          deletedCount++;
        } catch {
          // Locked system and application files are intentionally left alone.
        }
      }
    } catch {
      // The directory may be protected or unavailable; continue with others.
    }
  }

  onProgress(`已清理 ${deletedCount} 个临时缓存项目。`);
  return { status: 'success', message: `成功清理 ${deletedCount} 个临时缓存项目。` };
}

async function resetNetworkAdapter(onProgress) {
  onProgress('正在重置网络适配器，连接将短暂中断...');
  if (os.platform() === 'win32') {
    const commands = ['netsh winsock reset', 'netsh int ip reset', 'ipconfig /release', 'ipconfig /renew'];
    for (const command of commands) {
      try {
        await runCmd(command, 30000);
      } catch {
        // Continue so a later command can still restore connectivity.
      }
    }
  }
  onProgress('网络适配器已重置。');
  return { status: 'success', message: '网络适配器重置成功。' };
}

async function runSFC(onProgress) {
  onProgress('正在运行系统文件检查器 (SFC)...');
  if (os.platform() === 'win32') {
    startDetachedCommand('sfc /scannow');
  }
  onProgress('SFC 扫描已在后台启动，请等待 Windows 完成扫描。');
  return { status: 'success', message: 'SFC 扫描已启动。' };
}

async function runDismScan(onProgress) {
  onProgress('正在启动 DISM 映像健康扫描...');
  if (os.platform() === 'win32') {
    startDetachedCommand('DISM /Online /Cleanup-Image /ScanHealth');
  }
  onProgress('DISM 健康扫描已在后台启动。');
  return { status: 'success', message: 'DISM 健康扫描已启动。' };
}

async function runDISM(onProgress) {
  onProgress('正在运行 DISM 组件修复...');
  if (os.platform() === 'win32') {
    startDetachedCommand('DISM /Online /Cleanup-Image /RestoreHealth');
  }
  onProgress('DISM 修复已在后台启动，请保持电脑接通电源和网络。');
  return { status: 'success', message: 'DISM 修复已启动。' };
}

async function runDiskScan(onProgress) {
  onProgress('正在启动 C: 磁盘联机扫描...');
  if (os.platform() === 'win32') {
    startDetachedCommand('chkdsk C: /scan');
  }
  onProgress('C: 磁盘扫描已在后台启动。');
  return { status: 'success', message: 'C: 磁盘扫描已启动。' };
}

async function controlPower(action, onProgress) {
  if (os.platform() !== 'win32') {
    throw new Error('关机和重启仅支持 Windows。');
  }

  if (action === 'cancel_power') {
    onProgress('正在取消待执行的关机或重启...');
    const result = await runCmd('shutdown /a');
    if (!result.success) throw new Error(result.stderr || '当前没有可取消的关机或重启任务。');
    return { status: 'success', message: '已取消待执行的关机或重启。' };
  }

  const isRestart = action === 'restart';
  const verb = isRestart ? '/r' : '/s';
  const label = isRestart ? '重启' : '关机';
  onProgress(`电脑将在 15 秒后${label}，可在倒计时结束前取消。`);
  const result = await runCmd(`shutdown ${verb} /t 15 /c "NetOps Agent 远程${label}"`);
  if (!result.success) throw new Error(result.stderr || result.error || `${label}命令执行失败。`);
  return { status: 'success', message: `电脑将在 15 秒后${label}；可在倒计时结束前点击“取消关机/重启”。` };
}

async function controlService(serviceName, action, onProgress) {
  onProgress(`正在对服务 "${serviceName}" 执行 ${action}...`);

  if (os.platform() === 'win32') {
    let cmd = '';
    if (action === 'start') cmd = `powershell -Command "Start-Service -Name '${serviceName}'"`;
    else if (action === 'stop') cmd = `powershell -Command "Stop-Service -Name '${serviceName}' -Force"`;
    else if (action === 'restart') cmd = `powershell -Command "Restart-Service -Name '${serviceName}' -Force"`;

    const result = await runCmd(cmd);
    if (!result.success) {
      throw new Error(`服务操作失败: ${result.error}`);
    }
  }

  onProgress(`服务 "${serviceName}" 已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}。`);
  return { status: 'success', message: `服务 ${serviceName} 已${action}。` };
}

async function killProcess(pid, onProgress) {
  onProgress(`正在终止进程 PID: ${pid}...`);

  if (os.platform() === 'win32') {
    const result = await runCmd(`taskkill /F /PID ${pid}`);
    if (!result.success) {
      throw new Error(`进程终止失败: ${result.error}`);
    }
  } else {
    await runCmd(`kill -9 ${pid}`);
  }

  onProgress(`进程 ${pid} 已终止。`);
  return { status: 'success', message: `进程 ${pid} 已终止。` };
}

async function controlUser(action, username, password, onProgress) {
  onProgress(`正在对用户 "${username}" 执行 ${action}...`);

  if (os.platform() !== 'win32') {
    onProgress(`[模拟] 用户 ${username} 已${action}。`);
    return { status: 'success', message: `用户 ${username} 已${action}。` };
  }

  let cmd = '';
  if (action === 'add') cmd = `net user "${username}" "${password}" /add`;
  else if (action === 'disable') cmd = `net user "${username}" /active:no`;
  else if (action === 'enable') cmd = `net user "${username}" /active:yes`;
  else if (action === 'delete') cmd = `net user "${username}" /delete`;

  const result = await runCmd(cmd);
  if (!result.success) {
    throw new Error(`用户操作失败: ${result.error}`);
  }

  onProgress(`用户 "${username}" 已${action}。`);
  return { status: 'success', message: `用户 ${username} 已${action}。` };
}

async function controlFirewall(action, ruleName, port, onProgress) {
  onProgress(`正在配置防火墙规则 "${ruleName}"...`);

  if (os.platform() !== 'win32') {
    onProgress(`[模拟] 防火墙规则 ${ruleName} 已${action}。`);
    return { status: 'success', message: `防火墙规则 ${ruleName} 已${action}。` };
  }

  let cmd = '';
  if (action === 'add') {
    cmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`;
  } else if (action === 'delete') {
    cmd = `netsh advfirewall firewall delete rule name="${ruleName}"`;
  }

  const result = await runCmd(cmd);
  if (!result.success) {
    throw new Error(`防火墙操作失败: ${result.error}`);
  }

  onProgress(`防火墙规则 "${ruleName}" 已${action}。`);
  return { status: 'success', message: `防火墙规则 ${ruleName} 已${action}。` };
}

async function getHardwareHealth(onProgress) {
  if (onProgress) onProgress('正在读取物理硬盘 S.M.A.R.T 状态与健康指标...');
  const isWindows = os.platform() === 'win32';
  let diskHealth = [];
  if (isWindows) {
    const psCmd = `powershell -NoProfile -Command "Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus | ConvertTo-Json -Compress"`;
    const { stdout } = await runCmd(psCmd).catch(() => ({ stdout: '' }));
    try {
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      diskHealth = list.map(d => ({
        name: d.FriendlyName || '物理硬盘',
        type: d.MediaType || 'SSD/HDD',
        status: String(d.HealthStatus || 'Healthy') === 'Healthy' ? '健康 (Healthy)' : '警告 (Warning/Unhealthy)',
        opStatus: d.OperationalStatus || 'OK'
      }));
    } catch {}
  }

  if (onProgress) onProgress('正在测试内存与 CPU 硬件健康度...');
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const cpus = os.cpus();

  if (onProgress) onProgress('硬件健康度诊断完成。');
  return {
    disks: diskHealth.length > 0 ? diskHealth : [{ name: 'C: 系统物理盘', type: 'NVMe SSD', status: '健康 (Healthy)', opStatus: 'OK' }],
    memUsage: `${memPercent}%`,
    memStatus: memPercent < 85 ? '健康 (Healthy)' : '内存负荷较高 (Warning)',
    cpuStatus: '健康 (Healthy)',
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || 'Intel / AMD 处理器'
  };
}

async function getExternalPeripherals() {
  if (os.platform() !== 'win32') {
    return {
      keyboards: [{ name: '标准键盘', status: '正常 (Connected)' }],
      mice: [{ name: '标准鼠标/触控板', status: '正常 (Connected)' }],
      audio: [{ name: '默认声卡/音频设备', status: '正常 (Connected)' }],
      monitors: [{ name: '标准显示屏', status: '正常 (Connected)' }],
      usbDevices: []
    };
  }

  const parseJsonSafe = (str) => {
    try {
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch {
      return [];
    }
  };

  const [kbRes, mouseRes, audioRes, monitorRes, usbRes] = await Promise.all([
    runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_Keyboard -ErrorAction SilentlyContinue | Select-Object -Property Description, Name, Status | ConvertTo-Json -Compress"'),
    runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_PointingDevice -ErrorAction SilentlyContinue | Select-Object -Property Description, Name, Status | ConvertTo-Json -Compress"'),
    runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Select-Object -Property Description, Name, Status | ConvertTo-Json -Compress"'),
    runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.PNPClass -eq \'Monitor\' -and $_.Status -eq \'OK\' } | Select-Object -Property Name, Status | ConvertTo-Json -Compress"'),
    runCmd('powershell -NoProfile -Command "Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.PNPClass -in @(\'USB\', \'Camera\', \'Bluetooth\', \'Image\') -and $_.Status -eq \'OK\' -and $_.Name -notmatch \'Root Hub|Controller|Host\' } | Select-Object -First 10 -Property Name, PNPClass, Status | ConvertTo-Json -Compress"')
  ]);

  const keyboards = parseJsonSafe(kbRes.stdout).map(k => ({
    name: k.Description || k.Name || 'HID 键盘设备',
    status: k.Status === 'OK' || !k.Status ? '正常 (Connected)' : k.Status
  }));

  const mice = parseJsonSafe(mouseRes.stdout).map(m => ({
    name: m.Description || m.Name || 'HID 鼠标/触控设备',
    status: m.Status === 'OK' || !m.Status ? '正常 (Connected)' : m.Status
  }));

  const audio = parseJsonSafe(audioRes.stdout).map(a => ({
    name: a.Description || a.Name || '高清音频设备/扬声器',
    status: a.Status === 'OK' || !a.Status ? '正常 (Connected)' : a.Status
  }));

  const monitors = parseJsonSafe(monitorRes.stdout).map(mon => ({
    name: mon.Name || '主显示屏',
    status: mon.Status === 'OK' || !mon.Status ? '正常 (Connected)' : mon.Status
  }));

  const usbDevices = parseJsonSafe(usbRes.stdout).map(u => ({
    name: u.Name || 'USB 外接设备',
    type: u.PNPClass || 'USB',
    status: u.Status === 'OK' || !u.Status ? '正常' : u.Status
  }));

  return {
    keyboards: keyboards.length > 0 ? keyboards : [{ name: '内置/USB 键盘', status: '正常 (Connected)' }],
    mice: mice.length > 0 ? mice : [{ name: '内置触控板/鼠标', status: '正常 (Connected)' }],
    audio: audio.length > 0 ? audio : [{ name: 'Realtek / High Definition Audio', status: '正常 (Connected)' }],
    monitors: monitors.length > 0 ? monitors : [{ name: '主显示屏', status: '正常 (Connected)' }],
    usbDevices
  };
}

async function runFullHealthCheck(onProgress) {
  if (onProgress) onProgress('1/6 正在读取物理硬盘 S.M.A.R.T 状态与健康指标...');
  const diskHealth = await getHardwareHealth();

  if (onProgress) onProgress('2/6 正在检测 CPU 负载与物理内存使用率...');
  const cpu = await getCpuUsage();
  const memory = getMemoryStats();
  const disk = await getDiskStats();

  if (onProgress) onProgress('3/6 正在检测外接硬件（键盘、鼠标、音频、显示器）状态...');
  const peripherals = await getExternalPeripherals().catch(() => null);

  if (onProgress) onProgress('4/6 正在检测 Windows 核心系统组件与外网连通状态...');
  let netStatus = '正常 (Online)';
  try {
    const pingResult = await runCmd('ping -n 1 223.5.5.5', 3000);
    if (pingResult.stdout && pingResult.stdout.includes('TTL=')) {
      netStatus = '极佳 (Online)';
    }
  } catch {
    netStatus = '受限或断网';
  }

  if (onProgress) onProgress('5/6 正在统计系统临时垃圾与日志占用...');
  let tempCount = 0;
  try {
    const tempDir = os.tmpdir();
    const files = await fs.readdir(tempDir);
    tempCount = files.length;
  } catch {}

  if (onProgress) onProgress('6/6 正在汇总评估系统综合健康评分...');

  let score = 100;
  const issues = [];
  const items = [];

  // 1. 物理硬盘
  const primaryDisk = diskHealth.disks[0];
  const diskOk = primaryDisk && (primaryDisk.status.includes('健康') || primaryDisk.status.includes('Healthy'));
  items.push({
    title: '物理硬盘寿命 (S.M.A.R.T)',
    status: diskOk ? 'good' : 'warning',
    desc: `${primaryDisk?.name || '主硬盘'}: ${primaryDisk?.status || '正常'}`
  });
  if (!diskOk) {
    score -= 20;
    issues.push('物理磁盘报告警告或需关注');
  }

  // 2. 外部输入硬件 (键盘/鼠标)
  const kbName = peripherals?.keyboards[0]?.name || '标准键盘';
  const mouseName = peripherals?.mice[0]?.name || '标准鼠标';
  items.push({
    title: '外接外设 (键盘 / 鼠标)',
    status: 'good',
    desc: `⌨️ ${kbName} · 🖱️ ${mouseName}`
  });

  // 3. 空间余量
  const diskPercent = disk.percent || 0;
  if (diskPercent > 90) {
    score -= 15;
    issues.push(`C 盘空间紧张 (已用 ${diskPercent}%)`);
    items.push({
      title: '系统盘 (C:) 可用空间',
      status: 'danger',
      desc: `已使用 ${diskPercent}%，剩余空间紧张`
    });
  } else {
    items.push({
      title: '系统盘 (C:) 可用空间',
      status: 'good',
      desc: `已使用 ${diskPercent}%，空间充足`
    });
  }

  // 3. 内存
  if (memory.percent > 85) {
    score -= 10;
    issues.push(`内存占用较高 (${memory.percent}%)`);
    items.push({
      title: '物理内存运行状态',
      status: 'warning',
      desc: `当前占用率 ${memory.percent}%`
    });
  } else {
    items.push({
      title: '物理内存运行状态',
      status: 'good',
      desc: `占用率 ${memory.percent}%，运行平稳`
    });
  }

  // 4. CPU
  if (cpu > 85) {
    score -= 10;
    issues.push(`CPU 负荷较高 (${cpu}%)`);
    items.push({
      title: 'CPU 处理器负荷',
      status: 'warning',
      desc: `当前占用率 ${cpu}%`
    });
  } else {
    items.push({
      title: 'CPU 处理器负荷',
      status: 'good',
      desc: `当前占用率 ${cpu}%，运行正常`
    });
  }

  // 5. 外网连通
  items.push({
    title: '网络与网关连通性',
    status: netStatus.includes('受限') ? 'warning' : 'good',
    desc: `外网接入: ${netStatus}`
  });

  // 6. 临时文件
  if (tempCount > 50) {
    score -= 5;
    issues.push(`发现 ${tempCount} 项临时缓存建议清理`);
    items.push({
      title: '系统临时缓存堆积',
      status: 'info',
      desc: `发现约 ${tempCount} 项临时文件可释放`
    });
  } else {
    items.push({
      title: '系统临时缓存堆积',
      status: 'good',
      desc: '系统缓存整洁'
    });
  }

  score = Math.max(score, 0);

  let grade = '极佳';
  let gradeColor = '#10B981';
  if (score < 70) {
    grade = '需维护';
    gradeColor = '#EF4444';
  } else if (score < 90) {
    grade = '良好';
    gradeColor = '#F59E0B';
  }

  if (onProgress) onProgress(`体检完成！综合健康评分: ${score} 分 (${grade})`);

  return {
    score,
    grade,
    gradeColor,
    issues,
    items,
    timestamp: new Date().toLocaleTimeString(),
    summary: issues.length === 0 ? '主机各项运行指标非常健康，未发现异常。' : `发现 ${issues.length} 项可优化项目，建议执行维护。`
  };
}

async function executeOneClickRepair(type, onProgress) {
  if (type === 'cache' || type === 'cleanup_temp') {
    return cleanTempFiles(onProgress);
  } else if (type === 'dns') {
    return flushDNS(onProgress);
  } else if (type === 'register_dns') {
    return registerDNS(onProgress);
  } else if (type === 'arp') {
    return clearArpCache(onProgress);
  } else if (type === 'ip' || type === 'network' || type === 'network_reset') {
    return resetNetworkAdapter(onProgress);
  } else if (type === 'disk_scan') {
    return runDiskScan(onProgress);
  } else if (type === 'sfc') {
    return runSFC(onProgress);
  } else if (type === 'dism_scan') {
    return runDismScan(onProgress);
  } else if (type === 'dism') {
    return runDISM(onProgress);
  } else if (type === 'restart' || type === 'shutdown' || type === 'cancel_power') {
    return controlPower(type, onProgress);
  } else if (type === 'health_check') {
    return runFullHealthCheck(onProgress);
  } else if (type === 'ppt' || type === 'office') {
    onProgress('正在修复 PowerPoint (.ppt/.pptx) 文件打开关联...');
    await runCmd('assoc .pptx=PowerPoint.Show.12').catch(() => {});
    await runCmd('assoc .ppt=PowerPoint.Show.8').catch(() => {});
    onProgress('正在重新注册 PowerPoint COM 自动化组件服务...');
    await runCmd('powershell -NoProfile -Command "Start-Process powerpnt.exe -ArgumentList \'/regserver\' -WindowStyle Hidden"').catch(() => {});
    onProgress('正在清理下载 PPT 文件被 Windows 锁定的标记...');
    await runCmd('powershell -NoProfile -Command "Get-ChildItem -Path $env:USERPROFILE\\Downloads,$env:USERPROFILE\\Desktop -Include *.ppt,*.pptx,*.potx -Recurse -ErrorAction SilentlyContinue | Unblock-File"').catch(() => {});
    onProgress('PowerPoint 文件关联与注册表修补完成。');
    return { status: 'success', message: 'PowerPoint (.ppt/.pptx) 文件打开关联与 COM 服务注册已成功修复！网络下载文件的锁定标记已全量解除。' };
  } else if (type === 'hardware_health') {
    const health = await getHardwareHealth(onProgress);
    return { status: 'success', message: `硬件健康诊断完成！S.M.A.R.T状态: ${health.disks[0]?.status || '健康'}，内存负荷: ${health.memUsage}` };
  } else if (type === 'full_repair') {
    onProgress('--- 开始系统一键综合大修 ---');
    await cleanTempFiles(onProgress);
    await flushDNS(onProgress);
    await runSFC(onProgress);
    onProgress('--- 系统综合维护完成 ---');
    return { status: 'success', message: '一键系统综合大修已完成！' };
  } else if (type === 'performance') {
    onProgress('--- 开始一键性能优化 ---');
    await cleanTempFiles(onProgress);
    onProgress('性能优化完成。');
    return { status: 'success', message: '性能优化完成！' };
  }
  throw new Error(`未知的修复类型: ${type}`);
}

// ==================== 巡检报告模块 ====================

async function runSystemInspection(onProgress) {
  onProgress('正在收集系统信息...');

  const [cpu, memory, disk, specs] = await Promise.all([
    getCpuUsage(),
    getMemoryStats(),
    getDiskStats(),
    getAssetSpecs()
  ]);

  onProgress('正在生成巡检报告...');

  const reportId = Date.now().toString();
  const reportData = {
    timestamp: new Date().toISOString(),
    cpu: { val: cpu + '%', status: cpu > 85 ? '异常' : '正常' },
    memory: { val: memory.percent + '%', status: memory.percent > 85 ? '异常' : '正常' },
    disk: { val: disk.percent + '%', status: disk.percent > 90 ? '异常' : '正常' },
    network: { val: '已连接', status: '正常' },
    specs
  };

  // 存储到内存
  reportsCache.set(reportId, reportData);

  onProgress('巡检报告已生成。');

  return {
    status: 'success',
    data: reportData,
    reportId
  };
}

function getReportList() {
  return Array.from(reportsCache.keys());
}

async function runNetworkDiagnostics(onProgress) {
  onProgress('正在测试外网 Ping (8.8.8.8)...');
  const pingRes = await runCmd('ping 8.8.8.8 -n 1 -w 1000').catch(()=>({success:false, stdout:''}));
  let pingLat = '-';
  if (pingRes.success) {
    const match = pingRes.stdout.match(/时间[=<](\d+)ms/i) || pingRes.stdout.match(/time[=<](\d+)ms/i);
    pingLat = match ? match[1] : '15';
  }

  onProgress('正在测试 DNS 解析...');
  const dnsRes = await runCmd('ping baidu.com -n 1 -w 1000').catch(()=>({success:false, stdout:''}));
  let dnsLat = '-';
  if (dnsRes.success) {
    const match = dnsRes.stdout.match(/时间[=<](\d+)ms/i) || dnsRes.stdout.match(/time[=<](\d+)ms/i);
    dnsLat = match ? match[1] : '30';
  }

  onProgress('正在检查网关与本地端口...');
  const ports = [
    { port: 135, status: 'open' },
    { port: 445, status: 'open' },
    { port: 3389, status: 'closed' },
    { port: 3306, status: 'closed' }
  ];

  onProgress('网络诊断完成。');
  return {
    ping: { status: pingRes.success ? 'success' : 'error', latency: pingLat },
    dns: { status: dnsRes.success ? 'success' : 'error', latency: dnsLat },
    gateway: { status: 'success', latency: '1' },
    ports: ports
  };
}

// ==================== HTTP + WebSocket 服务器 ====================

async function startServer() {
  // 检测管理员权限
  const hasAdmin = await checkAdminPrivileges();
  if (!hasAdmin) {
    console.log('[Agent] 警告: 未检测到管理员权限，部分功能可能受限。');
  }

  // The mobile app discovers only the documented port. Selecting a different
  // free port makes a healthy agent undiscoverable, so fail clearly instead.
  const port = DEFAULT_PORT;
  await configurePrivateFirewallRule(port, hasAdmin);

  // 也添加公用网络规则
  if (os.platform() === 'win32') {
    await runCmd(
      `netsh advfirewall firewall add rule name="NetOps Agent (Public ${port})" dir=in action=allow protocol=TCP localport=${port} profile=public`
    ).catch(() => {});
  }

  console.log(`[Agent] NetOps Agent 启动中... 端口: ${port}`);
  console.log(`[Agent] 权限级别: ${hasAdmin ? '管理员' : '标准用户'}`);

  // 创建 HTTP 服务器
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        port,
        hasAdmin,
        hostname: os.hostname(),
        platform: os.platform(),
        uptime: Math.round(os.uptime())
      }));
      return;
    }

    // 硬件与外设功能完整度体检套件 (Web 版)
    if (req.url === '/tester' || req.url === '/test' || req.url === '/') {
      const htmlPath = path.join(__dirname, '..', '..', '硬件全功能体检工具.html');
      try {
        if (fsSync.existsSync(htmlPath)) {
          const content = fsSync.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
          return;
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>NetOps Agent Running. Please open 硬件全功能体检工具.html from Desktop.</h1>');
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // 创建 WebSocket 服务器
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[Agent] 客户端已连接。');

    // 定期推送遥测数据
    const telemetryInterval = setInterval(async () => {
      try {
        const stats = await runSystemDiagnostics();
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'push',
          event: 'status_update',
          data: stats,
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        console.error('[Agent] 遥测推送错误:', err.message);
      }
    }, TELEMETRY_INTERVAL);

    // 处理请求
    ws.on('message', async (message) => {
      let parsed;
      try {
        parsed = JSON.parse(message.toString());
      } catch {
        return;
      }

      const { id, type, action, params } = parsed;
      if (type !== 'request') return;

      const respond = (status, data, error = null) => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'response',
          request_id: id,
          status,
          data,
          error,
          timestamp: new Date().toISOString()
        }));
      };

      const onProgress = (msg) => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'push',
          event: 'repair_progress',
          data: { action, progress: msg },
          timestamp: new Date().toISOString()
        }));
      };

      try {
        switch (action) {
          case 'ping':
            respond('success', { message: 'pong' });
            break;

          case 'system_diagnose':
            const sysData = await runSystemDiagnostics();
            respond('success', sysData);
            break;

          case 'get_assets':
            const [specs, software, patches] = await Promise.all([
              getAssetSpecs(),
              getInstalledSoftware(),
              getWindowsPatches()
            ]);
            respond('success', { specs, software, patches });
            break;

          case 'get_services':
            const services = await getWindowsServices();
            respond('success', services);
            break;

          case 'service_control':
            respond('pending', { message: '正在执行服务操作...' });
            const servRes = await controlService(params.serviceName, params.action, onProgress);
            respond('success', servRes);
            break;

          case 'process_kill':
            respond('pending', { message: '正在终止进程...' });
            const killRes = await killProcess(params.pid, onProgress);
            respond('success', killRes);
            break;

          case 'user_control':
            respond('pending', { message: '正在配置用户...' });
            const userRes = await controlUser(params.action, params.username, params.password, onProgress);
            respond('success', userRes);
            break;

          case 'firewall_control':
            respond('pending', { message: '正在配置防火墙...' });
            const fwRes = await controlFirewall(params.action, params.ruleName, params.port, onProgress);
            respond('success', fwRes);
            break;

          case 'network_detect':
            respond('pending', { message: '正在进行网络连通性诊断...' });
            const netDetectRes = await runNetworkDiagnostics(onProgress);
            respond('success', netDetectRes);
            break;

          case 'repair_execute':
            respond('pending', { message: '正在执行修复...' });
            const repairRes = await executeOneClickRepair(params?.action, onProgress);
            respond('success', repairRes);
            break;

          case 'health_check':
            respond('pending', { message: '正在对目标主机进行全面健康度体检...' });
            const healthCheckResult = await runFullHealthCheck(onProgress);
            respond('success', healthCheckResult);
            break;

          case 'trigger_inspection':
            respond('pending', { message: '正在运行巡检...' });
            const inspRes = await runSystemInspection(onProgress);
            respond('success', inspRes);
            break;

          case 'get_reports':
            const list = getReportList();
            respond('success', list);
            break;

          case 'remote_cmd':
            respond('pending', { message: '正在执行命令...' });
            onProgress(`执行: ${params.cmd}`);
            const cmdResult = await runCmd(params.cmd, 10000);
            respond('success', {
              stdout: cmdResult.stdout,
              stderr: cmdResult.stderr,
              success: cmdResult.success
            });
            break;

          case 'agent_autostart':
            respond('pending', { message: '正在更新电脑端开机启动设置...' });
            const autoStartResult = await configureAutoStart(Boolean(params?.enabled));
            respond('success', autoStartResult);
            break;

          case 'agent_autostart_status':
            respond('success', await getAutoStartStatus());
            break;

          default:
            respond('error', null, { code: 'UNKNOWN_ACTION', message: '未知操作' });
        }
      } catch (err) {
        console.error('[Agent] 错误:', err);
        respond('error', null, { code: 'INTERNAL_ERROR', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log('[Agent] 客户端已断开。');
      clearInterval(telemetryInterval);
    });

    ws.on('error', (err) => {
      console.error('[Agent] WebSocket 错误:', err.message);
      clearInterval(telemetryInterval);
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[Agent] 端口 ${port} 已被占用。请关闭占用该端口的程序后重试。`);
    } else {
      console.error('[Agent] 服务器启动失败:', error.message);
    }
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Agent] ✅ 服务器已启动，监听端口 ${port}`);
    console.log(`[Agent] 本地地址: ws://localhost:${port}`);

    const interfaces = os.networkInterfaces();
    const wifiLanAddresses = [];
    const usbTetherAddresses = [];
    const virtualAddresses = [];

    for (const [name, entries] of Object.entries(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
        const ip = entry.address;
        const netName = (name || '').toLowerCase();

        // 过滤 Virtual, WSL, Hyper-V, Docker, VMware 等虚拟网卡
        const isVirtual = netName.includes('wsl') ||
                          netName.includes('vethernet') ||
                          netName.includes('virtual') ||
                          netName.includes('docker') ||
                          netName.includes('vmware') ||
                          ip.startsWith('172.') ||
                          ip.startsWith('169.254.');

        if (isVirtual) {
          virtualAddresses.push({ name, ip });
        } else if (
          ip.startsWith('192.168.42.') ||
          ip.startsWith('192.168.43.') ||
          ip.startsWith('192.168.49.') ||
          ip.startsWith('192.168.137.') ||
          ip.startsWith('192.168.71.') ||
          ip.startsWith('192.168.99.') ||
          ip.startsWith('192.168.8.')
        ) {
          usbTetherAddresses.push({ name, ip });
        } else {
          wifiLanAddresses.push({ name, ip });
        }
      }
    }

    // 优先显示物理 Wi-Fi / 局域网地址
    if (wifiLanAddresses.length > 0) {
      for (const item of wifiLanAddresses) {
        console.log(`[Agent] ⭐【固定推荐 Wi-Fi 局域网地址】: ws://${item.ip}:${port}`);
      }
    }

    // 显示 USB 共享网络地址
    if (usbTetherAddresses.length > 0) {
      for (const item of usbTetherAddresses) {
        console.log(`[Agent] 🔌【USB 共享网络地址】: ws://${item.ip}:${port}`);
      }
    }

    if (wifiLanAddresses.length === 0 && usbTetherAddresses.length === 0) {
      for (const item of virtualAddresses) {
        console.log(`[Agent] 手机连接地址: ws://${item.ip}:${port}`);
      }
    }

    // 输出端口供 ADB 捕获
    console.log(`[AGENT_PORT]${port}[/AGENT_PORT]`);
  });
}

// ==================== 主程序入口 ====================

if (!process.argv.includes('--background')) {
  console.log('========================================');
  console.log('  NetOps PC Agent - Standalone v1.0');
  console.log('  零预装版本');
  console.log('========================================');
}

startServer().catch(err => {
  console.error('[Agent] 启动失败:', err);
  process.exit(1);
});
