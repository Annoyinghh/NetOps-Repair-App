import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  StatusBar,
  FlatList,
  Platform,
  Modal,
} from 'react-native';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ==================== 常量配置 ====================
const AGENT_PORT = 3001;
const SCAN_TIMEOUT_MS = 600;
const SCAN_CONCURRENCY = 80;
const STATUS_BAR_HEIGHT = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0;
const MONOSPACE_FONT = Platform.OS === 'ios' ? 'Courier' : 'monospace';

const COMMAND_PRESETS = [
  { label: '网络配置', command: 'ipconfig /all' },
  { label: '系统信息', command: 'systeminfo' },
  { label: '网络连通', command: 'ping 223.5.5.5 -n 4' },
  { label: '活跃端口', command: 'netstat -ano' },
  { label: '运行进程', command: 'tasklist' },
  { label: '磁盘空间', command: 'powershell -NoProfile -Command "Get-Volume | Select-Object DriveLetter,FileSystemLabel,SizeRemaining,Size | Format-Table -AutoSize"' },
];

const DEFAULT_BOOKMARKS = [
  { id: '1', name: '机房 A区-主控机', address: 'ws://192.168.1.100:3001' },
  { id: '2', name: '机房 B区-服务器', address: 'ws://10.0.0.2:3001' },
  { id: '3', name: '本地工作站 PC', address: 'ws://192.168.2.102:3001' },
];

export default function App() {
  // 核心连接状态
  const [url, setUrl] = useState('');
  const [usbUrl, setUsbUrl] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeHostInfo, setActiveHostInfo] = useState(null);

  // 主导航 Tab: 'dashboard' (仪表盘) | 'repairs' (一键维护) | 'control' (管控中心) | 'devices' (机房设备)
  const [currentTab, setCurrentTab] = useState('dashboard');

  // 机房设备库与嗅探状态
  const [bookmarks, setBookmarks] = useState(DEFAULT_BOOKMARKS);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [isScanningSubnet, setIsScanningSubnet] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceAddr, setNewDeviceAddr] = useState('');

  // 日志与控制台
  const [logs, setLogs] = useState([]);
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false);
  const [runningTaskName, setRunningTaskName] = useState(null);

  // 遥测数据
  const [cpu, setCpu] = useState(0);
  const [memory, setMemory] = useState(0);
  const [disk, setDisk] = useState({ percent: 0, free: '0 GB', total: '0 GB', mount: 'C:' });
  const [sysInfo, setSysInfo] = useState({ platform: '-', release: '-', uptime: '-' });
  const [assetSpecs, setAssetSpecs] = useState(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState(null);

  // 进程与服务
  const [processes, setProcesses] = useState([]);
  const [procSearch, setProcSearch] = useState('');
  const [services, setServices] = useState([]);
  const [customCmd, setCustomCmd] = useState('');
  const [portScanResults, setPortScanResults] = useState(null);

  // 确认操作弹层
  const [confirmModal, setConfirmModal] = useState({
    visible: false,
    title: '',
    message: '',
    confirmText: '确认执行',
    isDanger: false,
    onConfirm: null,
  });

  const wsRef = useRef(null);
  const logScrollRef = useRef(null);

  // 1. 初始化：读取持久化设备列表 + 启动自动雷达嗅探
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem('@netops_devices_bookmarks_v2');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setBookmarks(parsed);
          }
        }
      } catch (e) {
        console.log('Failed to load bookmarks', e);
      }
      // 启动时自动雷达探测本地网络
      autoRadarScanAndConnect();
    })();
  }, []);

  async function persistBookmarks(newBookmarks) {
    setBookmarks(newBookmarks);
    try {
      await AsyncStorage.setItem('@netops_devices_bookmarks_v2', JSON.stringify(newBookmarks));
    } catch (e) {
      console.log('Failed to save bookmarks', e);
    }
  }

  // ==================== 智能雷达全网段嗅探 (零输入自动连) ====================
  function normalizeAgentUrl(value) {
    let candidate = (value || '').trim();
    if (!candidate) return null;
    if (!/^wss?:\/\//i.test(candidate)) candidate = `ws://${candidate}`;
    candidate = candidate.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const match = candidate.match(/^(wss?:\/\/)([^/:]+)(?::(\d+))?\/?$/i);
    if (!match) return null;
    return `${match[1].toLowerCase()}${match[2]}:${match[3] || AGENT_PORT}`;
  }

  async function probeAgent(host) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${host}:${AGENT_PORT}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json();
      if (body?.status === 'ok') {
        return {
          host,
          hostname: body.hostname || `主机 (${host})`,
          hasAdmin: Boolean(body.hasAdmin),
          uptime: body.uptime,
          url: `ws://${host}:${AGENT_PORT}`,
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function findAllAgents(hosts) {
    const found = [];
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, hosts.length) }, async () => {
      while (nextIndex < hosts.length) {
        const target = hosts[nextIndex++];
        const res = await probeAgent(target);
        if (res) found.push(res);
      }
    });
    await Promise.all(workers);
    return found;
  }

  // 自动嗅探并一键直连
  async function autoRadarScanAndConnect(forceManual = false) {
    setIsScanningSubnet(true);
    if (forceManual) addLog('正在全网段雷达嗅探机房在线主机...', 'system');

    const candidates = new Set();
    try {
      const ip = await Network.getIpAddressAsync();
      if (ip && ip !== '127.0.0.1' && ip !== '0.0.0.0') {
        const match = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/);
        if (match) {
          const ownHost = Number(match[2]);
          for (let host = 1; host <= 254; host += 1) {
            if (host !== ownHost) candidates.add(`${match[1]}.${host}`);
          }
        }
      }
    } catch (e) {
      console.log('Failed to get ip', e);
    }

    // 常用机房网段与 USB 共享网络网段
    const commonSubnets = ['192.168.2', '192.168.1', '192.168.0', '192.168.42', '192.168.43', '198.18', '10.0.0'];
    for (const sub of commonSubnets) {
      for (const host of [1, 2, 3, 55, 76, 88, 100, 101, 102, 108, 120, 200, 254]) {
        candidates.add(`${sub}.${host}`);
      }
    }

    const results = await findAllAgents([...candidates]);
    setIsScanningSubnet(false);
    setDiscoveredDevices(results);

    if (results.length > 0) {
      addLog(`✨ 雷达发现 ${results.length} 台在线 Agent 主机！`, 'recv');
      // 如果当前未连接且只发现 1 台主机，自动直接连入！
      if (!isConnected && results.length === 1) {
        const target = results[0];
        addLog(`⚡ 已自动定位到唯一在线主机【${target.hostname}】(${target.url})，立即连接...`, 'recv');
        connectToWs(target.url);
      }
    } else if (forceManual) {
      addLog('未在当前网段发现运行中的 NetOpsAgent。请确认电脑已启动 Agent 或在设备库手动填入 IP。', 'err');
      Alert.alert('未发现设备', '未嗅探到运行中的电脑端 Agent。请确保电脑已运行 NetOpsAgent.exe，且手机与电脑连接同一网络。');
    }
  }

  // ==================== WebSocket 通信 ====================
  function getTimestamp() {
    return new Date().toTimeString().substring(0, 8);
  }

  function addLog(text, type = 'system') {
    setLogs(prev => [...prev, { time: getTimestamp(), text, type }]);
    if (type === 'err' || type === 'sent' || type === 'prog') {
      setIsLogDrawerOpen(true);
    }
  }

  function connectToWs(targetUrl) {
    const finalUrl = normalizeAgentUrl(targetUrl || url);
    if (!finalUrl) {
      Alert.alert('提示', '请输入有效的通信地址 (如 ws://192.168.2.102:3001)');
      return;
    }
    setUrl(finalUrl);
    setConnecting(true);
    addLog(`正在连接目标主机通道: ${finalUrl}...`, 'sent');

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      const ws = new WebSocket(finalUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setConnecting(false);
        addLog(`✅ 通信隧道已建立！成功接入目标主机。`, 'recv');
        // 主动请求系统诊断、资产和自启状态
        sendAgentRequest('system_diagnose');
        sendAgentRequest('get_assets');
        sendAgentRequest('agent_autostart_status');
        sendAgentRequest('get_services');
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          handleAgentMessage(data);
        } catch (err) {
          addLog(`数据解析异常: ${e.data}`, 'err');
        }
      };

      ws.onerror = (e) => {
        setConnecting(false);
        addLog(`通信出错: ${e.message || '连接失败'}`, 'err');
      };

      ws.onclose = () => {
        setIsConnected(false);
        setConnecting(false);
        setRunningTaskName(null);
        addLog('⚠️ 与目标主机的连接已断开。', 'system');
      };
    } catch (error) {
      setConnecting(false);
      addLog(`连接失败: ${error.message}`, 'err');
    }
  }

  function disconnectWs() {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    setActiveHostInfo(null);
    addLog('已主动断开当前主机连接。', 'system');
  }

  function sendAgentRequest(action, params = {}) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('无法发送指令：尚未连接到电脑端 Agent。', 'err');
      return;
    }
    const msg = {
      id: Date.now().toString(),
      type: 'request',
      action,
      params,
    };
    wsRef.current.send(JSON.stringify(msg));
  }

  function handleAgentMessage(data) {
    // 1. 处理 Agent push 的 status_update 实时遥测
    if (data.type === 'push' && data.event === 'status_update' && data.data) {
      const stats = data.data;
      if (stats.cpu !== undefined) {
        setCpu(typeof stats.cpu === 'number' ? stats.cpu : (stats.cpu?.percent || 0));
      }
      if (stats.memory !== undefined) {
        setMemory(typeof stats.memory === 'number' ? stats.memory : (stats.memory?.percent || 0));
      }
      if (stats.disk) {
        const freeGB = stats.disk.free ? (stats.disk.free / 1024 / 1024 / 1024).toFixed(1) : '0';
        const totalGB = stats.disk.total ? (stats.disk.total / 1024 / 1024 / 1024).toFixed(1) : '0';
        setDisk({
          percent: stats.disk.percent || 0,
          free: `${freeGB} GB`,
          total: `${totalGB} GB`,
          mount: stats.disk.mount || 'C:',
        });
      }
      if (stats.system) {
        setSysInfo(stats.system);
        setActiveHostInfo(stats.system);
      }
      if (stats.specs) {
        setAssetSpecs(stats.specs);
      }
      return;
    }

    // 2. 处理 push repair_progress
    if (data.type === 'push' && data.event === 'repair_progress') {
      const prog = data.data?.progress || data.data?.message || '';
      addLog(`[执行进度] ${prog}`, 'prog');
      return;
    }

    // 3. 处理 response (通用请求应答)
    if (data.type === 'response') {
      if (data.status === 'pending') {
        addLog(`[已下发] ${data.data?.message || 'Agent 已接收指令，正在执行...'}`, 'sent');
        return;
      }
      if (data.status === 'success') {
        // 系统诊断数据
        if (data.data?.system) {
          setSysInfo(data.data.system);
          setActiveHostInfo(data.data.system);
        }
        if (data.data?.specs) {
          setAssetSpecs(data.data.specs);
        }
        // 服务列表
        if (Array.isArray(data.data) && data.data.length > 0 && data.data[0]?.name) {
          setServices(data.data);
        }
        // 命令回显
        if (data.data?.stdout !== undefined) {
          const out = data.data.stdout?.trim() || '(无标准输出)';
          addLog(`[终端回显]\n${out}`, 'recv');
          if (data.data.stderr?.trim()) {
            addLog(`[错误输出]\n${data.data.stderr.trim()}`, 'err');
          }
          return;
        }
        // 开机自启状态
        if (data.data?.enabled !== undefined) {
          setAutoStartEnabled(Boolean(data.data.enabled));
        }
        // 通用完成消息 (修复完成等)
        if (data.data?.message) {
          setRunningTaskName(null);
          addLog(`✅ ${data.data.message}`, 'recv');
          Alert.alert('执行完成', data.data.message);
          return;
        }
      } else if (data.status === 'error') {
        setRunningTaskName(null);
        addLog(`❌ 执行失败: ${data.error?.message || '未知错误'}`, 'err');
        Alert.alert('执行失败', data.error?.message || '操作未成功。');
        return;
      }
    }
  }

  // ==================== 设备管理方法 ====================
  function handleAddBookmark(name, address, autoConnect = false) {
    const rawAddr = (address || '').trim() || url || 'ws://192.168.2.102:3001';
    const normalized = normalizeAgentUrl(rawAddr) || rawAddr;
    const item = {
      id: Date.now().toString(),
      name: (name || '').trim() || `机房主机 (${normalized.replace('ws://', '')})`,
      address: normalized,
    };
    const updated = [item, ...bookmarks.filter(b => b.address !== normalized)];
    persistBookmarks(updated);
    setNewDeviceName('');
    setNewDeviceAddr('');

    if (autoConnect) {
      connectToWs(normalized);
      setCurrentTab('dashboard');
    } else {
      Alert.alert('✅ 保存成功', `已将【${item.name}】(${item.address}) 存入机房设备库！`);
    }
  }

  function handleDeleteBookmark(id) {
    const updated = bookmarks.filter(b => b.id !== id);
    persistBookmarks(updated);
  }

  // ==================== 快捷维护动作 ====================
  function executeRepair(type, title, desc, isDanger = false) {
    if (!isConnected) {
      Alert.alert('未连接', '请先连接到目标电脑再执行此操作。');
      return;
    }
    setConfirmModal({
      visible: true,
      title: `确认执行: ${title}`,
      message: `${desc}\n\n执行期间命令在电脑后台持续运行，进度将实时同步在日志面板中。`,
      confirmText: isDanger ? '确认执行危险操作' : '立即执行',
      isDanger,
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, visible: false }));
        setRunningTaskName(title);
        setIsLogDrawerOpen(true);
        addLog(`正在向主机下发指令【${title}】...`, 'sent');

        let mappedAction = 'cache';
        if (type === 'sfc') mappedAction = 'sfc';
        else if (type === 'dism') mappedAction = 'dism';
        else if (type === 'network_reset') mappedAction = 'network';
        else if (type === 'cleanup_temp') mappedAction = 'cache';
        else if (type === 'restart') mappedAction = 'restart';
        else if (type === 'shutdown') mappedAction = 'shutdown';

        sendAgentRequest('repair_execute', { action: mappedAction });
      },
    });
  }

  function executeCustomCommand() {
    if (!customCmd.trim()) return;
    addLog(`> ${customCmd}`, 'sent');
    setIsLogDrawerOpen(true);
    sendAgentRequest('remote_cmd', { cmd: customCmd.trim() });
  }

  function killProcess(pid, name) {
    setConfirmModal({
      visible: true,
      title: `结束进程`,
      message: `确定要强制终止进程【${name} (PID: ${pid})】吗？`,
      confirmText: '强制结束',
      isDanger: true,
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, visible: false }));
        addLog(`正在强制结束进程: ${name} (PID: ${pid})...`, 'sent');
        sendAgentRequest('process_kill', { pid });
      },
    });
  }

  // 过滤进程列表
  const filteredProcesses = processes.filter(p =>
    (p.name || '').toLowerCase().includes(procSearch.toLowerCase()) ||
    String(p.pid || '').includes(procSearch)
  ).slice(0, 20);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0F1D" />

      {/* ==================== 顶部智能状态条 (Hero Header) ==================== */}
      <View style={styles.heroHeader}>
        <View style={styles.headerTitleRow}>
          <View style={styles.brandBadge}>
            <View style={[styles.statusDot, isConnected ? styles.dotConnected : styles.dotDisconnected]} />
            <Text style={styles.brandTitle}>NetOps 运维中枢</Text>
          </View>

          {/* 连接/嗅探状态胶囊 */}
          <TouchableOpacity
            style={[styles.connectionCapsule, isConnected ? styles.capsuleOnline : styles.capsuleOffline]}
            onPress={() => {
              if (isConnected) {
                Alert.alert('已连通主机', `主机: ${activeHostInfo?.hostname || 'Windows PC'}\n通道: ${url}`, [
                  { text: '保持连接', style: 'cancel' },
                  { text: '断开连接', style: 'destructive', onPress: disconnectWs }
                ]);
              } else {
                autoRadarScanAndConnect(true);
              }
            }}
          >
            {connecting || isScanningSubnet ? (
              <ActivityIndicator size="small" color="#38BDF8" style={{ marginRight: 6 }} />
            ) : null}
            <Text style={[styles.capsuleText, isConnected ? styles.capsuleTextOnline : styles.capsuleTextOffline]}>
              {isConnected
                ? `🟢 ${activeHostInfo?.hostname || '已连通'} (Admin)`
                : isScanningSubnet
                  ? '📡 正在嗅探...'
                  : '🔴 未连接 (点击自动嗅探)'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* 正在运行的后台任务高亮条 */}
        {runningTaskName && (
          <View style={styles.runningBanner}>
            <ActivityIndicator size="small" color="#38BDF8" style={{ marginRight: 8 }} />
            <Text style={styles.runningBannerText}>正在执行后台任务: {runningTaskName}</Text>
            <TouchableOpacity onPress={() => setIsLogDrawerOpen(true)}>
              <Text style={styles.runningBannerLink}>查看日志 ➔</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ==================== 主内容视图 ==================== */}
      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainScrollContent}
        nestedScrollEnabled={true}
        keyboardShouldPersistTaps="handled"
      >
        {/* ========== TAB 1: 仪表盘 (DASHBOARD) ========== */}
        {currentTab === 'dashboard' && (
          <View>
            {/* 未连接时的快速雷达提示卡片 */}
            {!isConnected && (
              <View style={styles.radarCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={{ fontSize: 18, marginRight: 8 }}>📡</Text>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#F8FAFC' }}>
                    局域网 / 机房快速自动连通
                  </Text>
                </View>
                <Text style={styles.radarSub}>
                  电脑上运行 NetOpsAgent.exe 后，点击下方雷达按钮，手机会自动发现并秒连主机。
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary, { flex: 1 }]}
                    onPress={() => autoRadarScanAndConnect(true)}
                    disabled={isScanningSubnet || connecting}
                  >
                    {isScanningSubnet ? <ActivityIndicator size="small" color="#0A0F1D" /> : <Text style={styles.btnText}>🔍 一键雷达嗅探连接</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnSecondary, { width: 100 }]}
                    onPress={() => setCurrentTab('devices')}
                  >
                    <Text style={[styles.btnText, { color: '#38BDF8' }]}>设备库</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* 实时系统指标卡片 (CPU / 内存 / 磁盘) */}
            <View style={styles.sectionContainer}>
              <Text style={styles.sectionTitle}>⚡ 实时系统负载监控</Text>
              <View style={styles.gaugesRow}>
                {/* CPU 指标 */}
                <View style={styles.gaugeCard}>
                  <Text style={styles.gaugeLabel}>CPU 负载</Text>
                  <Text style={[styles.gaugeVal, { color: cpu > 80 ? '#FB7185' : '#38BDF8' }]}>{cpu}%</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressBar, { width: `${Math.min(cpu, 100)}%`, backgroundColor: cpu > 80 ? '#FB7185' : '#38BDF8' }]} />
                  </View>
                </View>

                {/* 内存指标 */}
                <View style={styles.gaugeCard}>
                  <Text style={styles.gaugeLabel}>内存占用</Text>
                  <Text style={[styles.gaugeVal, { color: memory > 85 ? '#FB7185' : '#34D399' }]}>{memory}%</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressBar, { width: `${Math.min(memory, 100)}%`, backgroundColor: memory > 85 ? '#FB7185' : '#34D399' }]} />
                  </View>
                </View>

                {/* 磁盘指标 */}
                <View style={styles.gaugeCard}>
                  <Text style={styles.gaugeLabel}>C盘使用率</Text>
                  <Text style={[styles.gaugeVal, { color: disk.percent > 90 ? '#FB7185' : '#F59E0B' }]}>{disk.percent}%</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressBar, { width: `${Math.min(disk.percent, 100)}%`, backgroundColor: disk.percent > 90 ? '#FB7185' : '#F59E0B' }]} />
                  </View>
                </View>
              </View>
            </View>

            {/* 资产与系统详细信息卡片 */}
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <Text style={styles.cardTitle}>🖥️ 目标主机系统规格</Text>
                {isConnected && (
                  <TouchableOpacity
                    style={styles.smallBadge}
                    onPress={() => sendAgentRequest('get_assets')}
                  >
                    <Text style={styles.smallBadgeText}>🔄 刷新</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.infoLbl}>主机名称</Text>
                <Text style={styles.infoVal}>{activeHostInfo?.hostname || assetSpecs?.hostname || '未连接'}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLbl}>操作系统</Text>
                <Text style={styles.infoVal}>{sysInfo.platform} {sysInfo.release}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLbl}>处理器架构</Text>
                <Text style={styles.infoVal}>{assetSpecs?.cpuModel || '-'}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLbl}>物理内存</Text>
                <Text style={styles.infoVal}>{assetSpecs?.memoryGB ? `${assetSpecs.memoryGB} GB` : '-'}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLbl}>系统运行时间</Text>
                <Text style={styles.infoVal}>{sysInfo.uptime}</Text>
              </View>
            </View>

            {/* 开机自启动与常驻管理 */}
            {isConnected && (
              <View style={styles.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: '#F8FAFC' }}>
                      🚀 Agent 开机自启动驻留
                    </Text>
                    <Text style={{ fontSize: 12, color: '#94A3B8', marginTop: 2 }}>
                      开启后电脑开机将在后台静默常驻，手机随时随地可直接接入。
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.btn, autoStartEnabled ? styles.btnDanger : styles.btnPrimary, { height: 38, paddingHorizontal: 14 }]}
                    onPress={() => {
                      const next = !autoStartEnabled;
                      sendAgentRequest('agent_autostart', { enabled: next });
                      setAutoStartEnabled(next);
                      addLog(`已设置开机自启动为: ${next ? '开启' : '关闭'}`, 'sent');
                    }}
                  >
                    <Text style={styles.btnText}>{autoStartEnabled ? '已开启 (关闭)' : '开启自启'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* ========== TAB 2: 一键维护 (REPAIRS) ========== */}
        {currentTab === 'repairs' && (
          <View>
            <Text style={styles.sectionTitle}>🛠️ 常见系统故障一键修复矩阵</Text>
            
            {/* SFC 修复 */}
            <View style={styles.repairCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.repairTitle}>🛡️ SFC 系统完整性全面修复</Text>
                <Text style={styles.repairDesc}>
                  自动扫描系统受损核心文件，从组件存储中精准修复损坏项 (`sfc /scannow`)。
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { height: 42 }]}
                onPress={() => executeRepair('sfc', 'SFC 核心修复', '扫描并修复损坏的系统底层核心文件')}
              >
                <Text style={styles.btnText}>立即执行</Text>
              </TouchableOpacity>
            </View>

            {/* DISM 修复 */}
            <View style={styles.repairCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.repairTitle}>🧹 DISM 镜像深度修复与清理</Text>
                <Text style={styles.repairDesc}>
                  深度扫描组件存储健康度并从官方源下载还原健康组件 (`DISM RestoreHealth`)。
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { height: 42 }]}
                onPress={() => executeRepair('dism', 'DISM 镜像修复', '深度检查并修复 Windows 组件存储')}
              >
                <Text style={styles.btnText}>立即执行</Text>
              </TouchableOpacity>
            </View>

            {/* 网络重置 */}
            <View style={styles.repairCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.repairTitle}>🌐 网络协议栈与 DNS 一键重置</Text>
                <Text style={styles.repairDesc}>
                  重置 Winsock 目录、清空 DNS 缓存、重置 TCP/IP 堆栈并重新获取 DHCP 地址。
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { height: 42 }]}
                onPress={() => executeRepair('network_reset', '网络协议栈重置', '重置 Winsock 与 DNS 缓存')}
              >
                <Text style={[styles.btnText, { color: '#38BDF8' }]}>一键重置</Text>
              </TouchableOpacity>
            </View>

            {/* 临时垃圾清理 */}
            <View style={styles.repairCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.repairTitle}>🗑️ 系统临时垃圾与缓存极速清理</Text>
                <Text style={styles.repairDesc}>
                  快速清理 Windows Temp 临时文件、回收站、预读取缓存 Prefetch 释放空间。
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { height: 42 }]}
                onPress={() => executeRepair('cleanup_temp', '垃圾深度清理', '清理系统临时文件与日志缓存')}
              >
                <Text style={[styles.btnText, { color: '#38BDF8' }]}>释放空间</Text>
              </TouchableOpacity>
            </View>

            {/* 安全电源控制 */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>⚡ 主机电源与安全控制</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary, { flex: 1 }]}
                  onPress={() => executeRepair('restart', '安全重启主机', '正在向主机发送平稳重启指令 (shutdown -r)', true)}
                >
                  <Text style={[styles.btnText, { color: '#F59E0B' }]}>🔄 安全重启</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnDanger, { flex: 1 }]}
                  onPress={() => executeRepair('shutdown', '安全关机', '正在向主机发送关机指令 (shutdown -s)', true)}
                >
                  <Text style={[styles.btnText, { color: '#FFF' }]}>🛑 远程关机</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ========== TAB 3: 管控中心 (CONTROL & CMD) ========== */}
        {currentTab === 'control' && (
          <View>
            {/* 远程命令终端 */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>💻 远程命令行交互终端</Text>
              <View style={styles.cmdRow}>
                <TextInput
                  style={styles.cmdInput}
                  value={customCmd}
                  onChangeText={setCustomCmd}
                  placeholder="输入任意 CMD / PowerShell 命令..."
                  placeholderTextColor="#64748B"
                  autoCapitalize="none"
                />
                <TouchableOpacity style={[styles.btn, styles.btnPrimary, { height: 44, paddingHorizontal: 16 }]} onPress={executeCustomCommand}>
                  <Text style={styles.btnText}>执行</Text>
                </TouchableOpacity>
              </View>

              {/* 常用预设快捷指令 */}
              <View style={styles.presetGrid}>
                {COMMAND_PRESETS.map((p, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.presetChip}
                    onPress={() => {
                      setCustomCmd(p.command);
                      addLog(`> ${p.command}`, 'sent');
                      setIsLogDrawerOpen(true);
                      sendAgentRequest('remote_cmd', { cmd: p.command });
                    }}
                  >
                    <Text style={styles.presetChipText}>{p.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* 进程管理器 */}
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <Text style={styles.cardTitle}>📊 活跃进程管控 (前20项)</Text>
                <TouchableOpacity
                  style={styles.smallBadge}
                  onPress={() => sendAgentRequest('remote_cmd', { cmd: 'tasklist' })}
                >
                  <Text style={styles.smallBadgeText}>🔄 刷新</Text>
                </TouchableOpacity>
              </View>

              <TextInput
                style={styles.searchInput}
                value={procSearch}
                onChangeText={setProcSearch}
                placeholder="搜索进程名或 PID..."
                placeholderTextColor="#64748B"
              />

              {filteredProcesses.length > 0 ? (
                filteredProcesses.map((proc, index) => (
                  <View key={index} style={styles.procRow}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={styles.procName}>{proc.name}</Text>
                      <Text style={styles.procPid}>PID: {proc.pid} · 内存: {proc.mem || '-'}</Text>
                    </View>
                    <TouchableOpacity
                      style={styles.killBtn}
                      onPress={() => killProcess(proc.pid, proc.name)}
                    >
                      <Text style={styles.killBtnText}>结束</Text>
                    </TouchableOpacity>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>
                  {processes.length === 0 ? '可在上方终端输入 tasklist 或点击快捷指令查看进程。' : '未搜索到匹配进程。'}
                </Text>
              )}
            </View>

            {/* 运维端口检测 */}
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text style={styles.cardTitle}>🔌 关键运维端口放行扫描</Text>
                <TouchableOpacity
                  style={styles.smallBadge}
                  onPress={() => sendAgentRequest('network_detect')}
                >
                  <Text style={styles.smallBadgeText}>⚡ 扫描端口</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.guideText}>自动检测 80(HTTP), 443(HTTPS), 3389(远程桌面), 3001(Agent), 8080 端口占用与监听状态。</Text>
              
              {portScanResults && portScanResults.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {portScanResults.map((p, idx) => (
                    <View key={idx} style={[styles.portBadge, p.open ? styles.portOpen : styles.portClosed]}>
                      <Text style={styles.portText}>{p.port} ({p.name}): {p.open ? '开放' : '未监听'}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        )}

        {/* ========== TAB 4: 机房设备库 (DEVICES & RADAR) ========== */}
        {currentTab === 'devices' && (
          <View>
            {/* 1. 雷达在线设备发现区 */}
            <View style={styles.radarCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#F8FAFC' }}>
                  📡 机房全网段雷达在线嗅探
                </Text>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { height: 36, paddingHorizontal: 12 }]}
                  onPress={() => autoRadarScanAndConnect(true)}
                  disabled={isScanningSubnet}
                >
                  {isScanningSubnet ? <ActivityIndicator size="small" color="#0A0F1D" /> : <Text style={styles.btnText}>重新嗅探</Text>}
                </TouchableOpacity>
              </View>
              <Text style={styles.radarSub}>
                自动扫描当前局域网段（1..254）内所有开启 NetOpsAgent 的主机。
              </Text>

              {/* 扫描到的在线列表 */}
              {discoveredDevices.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#38BDF8', marginBottom: 8 }}>
                    ✨ 实时发现在线设备 ({discoveredDevices.length} 台)：
                  </Text>
                  {discoveredDevices.map((dev, idx) => (
                    <View key={idx} style={styles.deviceRowCard}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.deviceTitle}>🖥️ {dev.hostname}</Text>
                        <Text style={styles.deviceAddress}>{dev.url}</Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity
                          style={[styles.btn, styles.btnPrimary, { height: 36, paddingHorizontal: 12 }]}
                          onPress={() => {
                            connectToWs(dev.url);
                            setCurrentTab('dashboard');
                          }}
                        >
                          <Text style={styles.btnText}>直连</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.btn, styles.btnSecondary, { height: 36, paddingHorizontal: 10 }]}
                          onPress={() => handleAddBookmark(dev.hostname, dev.url, false)}
                        >
                          <Text style={[styles.btnText, { color: '#38BDF8' }]}>⭐ 存库</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {/* 2. 手动录入新设备卡片 */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>➕ 手动录入新机房主机</Text>
              <TextInput
                style={styles.singleInput}
                value={newDeviceName}
                onChangeText={setNewDeviceName}
                placeholder="设备备注 (例: 3楼机房-数据库服务器)"
                placeholderTextColor="#64748B"
              />
              <TextInput
                style={styles.singleInput}
                value={newDeviceAddr}
                onChangeText={setNewDeviceAddr}
                placeholder="通信地址 (例: ws://192.168.2.102:3001)"
                placeholderTextColor="#64748B"
                autoCapitalize="none"
              />

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { flex: 1 }]}
                  onPress={() => handleAddBookmark(newDeviceName, newDeviceAddr, false)}
                >
                  <Text style={styles.btnText}>💾 存入设备库</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary, { flex: 1 }]}
                  onPress={() => handleAddBookmark(newDeviceName, newDeviceAddr, true)}
                >
                  <Text style={[styles.btnText, { color: '#38BDF8' }]}>⚡ 保存并连接</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* 3. 已保存的机房设备库列表 */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📋 已保存的机房设备库 ({bookmarks.length} 台)</Text>
              
              {bookmarks.length > 0 ? (
                bookmarks.map((bm) => (
                  <View key={bm.id} style={styles.deviceRowCard}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={styles.deviceTitle}>🖥️ {bm.name}</Text>
                      <Text style={styles.deviceAddress}>{bm.address}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        style={[styles.btn, styles.btnPrimary, { height: 36, paddingHorizontal: 12 }]}
                        onPress={() => {
                          connectToWs(bm.address);
                          setCurrentTab('dashboard');
                        }}
                      >
                        <Text style={styles.btnText}>⚡ 直连</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btn, styles.btnDanger, { height: 36, paddingHorizontal: 10 }]}
                        onPress={() => handleDeleteBookmark(bm.id)}
                      >
                        <Text style={[styles.btnText, { color: '#FFF' }]}>删除</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>暂无设备。可在上方输入地址添加，或使用雷达自动嗅探。</Text>
              )}
            </View>

            {/* 4. USB 直连指南 */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>🔌 USB 数据线直连备用模式</Text>
              <Text style={styles.guideText}>
                1. 用 USB 数据线将手机连接到电脑。{'\n'}
                2. 打开手机【设置 → 个人热点】开启“USB 网络共享” (Tethering)。{'\n'}
                3. 电脑端打开 NetOpsAgent.exe 即可自动通过 USB 隧道一键互通。
              </Text>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { marginTop: 4 }]}
                onPress={() => connectToWs('ws://192.168.42.2:3001')}
              >
                <Text style={[styles.btnText, { color: '#38BDF8' }]}>🔍 连接 USB 默认网关 (192.168.42.2)</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* ==================== 底部折叠/展开式终端控制台 ==================== */}
      <View style={[styles.terminalDrawer, isLogDrawerOpen ? styles.terminalDrawerExpanded : styles.terminalDrawerCollapsed]}>
        <TouchableOpacity
          style={styles.terminalHeader}
          onPress={() => setIsLogDrawerOpen(!isLogDrawerOpen)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
            <Text style={styles.terminalDot}>●</Text>
            <Text style={styles.terminalTitle}>实时运维日志与输出</Text>
            <Text style={styles.terminalCount}>({logs.length}条)</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => setLogs([])}>
              <Text style={styles.terminalClearText}>清空</Text>
            </TouchableOpacity>
            <Text style={styles.terminalToggleText}>{isLogDrawerOpen ? '▼ 收起' : '▲ 展开'}</Text>
          </View>
        </TouchableOpacity>

        {isLogDrawerOpen ? (
          <ScrollView
            style={styles.terminalBody}
            nestedScrollEnabled={true}
            ref={logScrollRef}
            onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: true })}
          >
            {logs.length > 0 ? (
              logs.map((log, idx) => (
                <Text key={idx} style={[styles.logText, styles[`log_${log.type}`]]}>
                  [{log.time}] {log.text}
                </Text>
              ))
            ) : (
              <Text style={[styles.logText, { color: '#64748B' }]}>暂无实时日志输出。</Text>
            )}
          </ScrollView>
        ) : (
          <TouchableOpacity onPress={() => setIsLogDrawerOpen(true)} style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            <Text style={[styles.logText, styles[`log_${logs[logs.length - 1]?.type || 'system'}`]]} numberOfLines={1}>
              最新: {logs[logs.length - 1]?.text || '就绪'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ==================== 底部主导航栏 (Bottom Nav Bar) ==================== */}
      <View style={styles.bottomNav}>
        {[
          { id: 'dashboard', icon: '📊', label: '仪表盘' },
          { id: 'repairs', icon: '🛠️', label: '一键维护' },
          { id: 'control', icon: '⚡', label: '管控中心' },
          { id: 'devices', icon: '🌐', label: '机房设备' },
        ].map((tab) => {
          const isActive = currentTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[styles.navTab, isActive && styles.navTabActive]}
              onPress={() => setCurrentTab(tab.id)}
            >
              <Text style={styles.navIcon}>{tab.icon}</Text>
              <Text style={[styles.navLabel, isActive && styles.navLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 二次确认操作 Modal */}
      <Modal
        visible={confirmModal.visible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setConfirmModal(prev => ({ ...prev, visible: false }))}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={[styles.modalTitle, confirmModal.isDanger && styles.modalTitleDanger]}>
              {confirmModal.title}
            </Text>
            <Text style={styles.modalMessage}>{confirmModal.message}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, { flex: 1 }]}
                onPress={() => setConfirmModal(prev => ({ ...prev, visible: false }))}
              >
                <Text style={[styles.btnText, { color: '#F8FAFC' }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, confirmModal.isDanger ? styles.btnDanger : styles.btnPrimary, { flex: 1 }]}
                onPress={confirmModal.onConfirm}
              >
                <Text style={[styles.btnText, { color: confirmModal.isDanger ? '#FFF' : '#0A0F1D' }]}>
                  {confirmModal.confirmText}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ==================== 样式体系 (Dark Navy & Clean Glass) ====================
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0A0F1D',
    paddingTop: STATUS_BAR_HEIGHT,
  },
  heroHeader: {
    backgroundColor: '#131E32',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  dotConnected: { backgroundColor: '#10B981' },
  dotDisconnected: { backgroundColor: '#FB7185' },
  brandTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.5,
  },
  connectionCapsule: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  capsuleOnline: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  capsuleOffline: {
    backgroundColor: 'rgba(251, 113, 133, 0.15)',
    borderWidth: 1,
    borderColor: '#FB7185',
  },
  capsuleText: {
    fontSize: 12,
    fontWeight: '700',
  },
  capsuleTextOnline: { color: '#34D399' },
  capsuleTextOffline: { color: '#FB7185' },
  runningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: '#38BDF8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 10,
  },
  runningBannerText: {
    fontSize: 12,
    color: '#38BDF8',
    fontWeight: '600',
    flex: 1,
  },
  runningBannerLink: {
    fontSize: 12,
    color: '#7DD3FC',
    fontWeight: '700',
  },
  mainScroll: {
    flex: 1,
  },
  mainScrollContent: {
    padding: 16,
    paddingBottom: 110,
  },
  radarCard: {
    backgroundColor: '#162238',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  radarSub: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 18,
  },
  sectionContainer: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#64748B',
    marginBottom: 10,
    marginLeft: 2,
    letterSpacing: 0.5,
  },
  gaugesRow: {
    flexDirection: 'row',
    gap: 10,
  },
  gaugeCard: {
    flex: 1,
    backgroundColor: '#131E32',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  gaugeLabel: {
    fontSize: 12,
    color: '#94A3B8',
    marginBottom: 4,
  },
  gaugeVal: {
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  progressTrack: {
    width: '100%',
    height: 6,
    backgroundColor: '#0A0F1D',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
  },
  card: {
    backgroundColor: '#131E32',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  guideText: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 20,
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  infoLbl: {
    fontSize: 13,
    color: '#94A3B8',
  },
  infoVal: {
    fontSize: 13,
    fontWeight: '600',
    color: '#F8FAFC',
    fontFamily: MONOSPACE_FONT,
    maxWidth: 220,
    textAlign: 'right',
  },
  smallBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  smallBadgeText: {
    fontSize: 11,
    color: '#38BDF8',
    fontWeight: '700',
  },
  repairCard: {
    backgroundColor: '#131E32',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  repairTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  repairDesc: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 18,
  },
  btn: {
    height: 46,
    paddingHorizontal: 16,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#38BDF8',
  },
  btnSecondary: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  btnDanger: {
    backgroundColor: '#FB7185',
  },
  btnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0A0F1D',
  },
  cmdRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  cmdInput: {
    flex: 1,
    backgroundColor: '#0A0F1D',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F8FAFC',
    fontSize: 13,
    height: 44,
    fontFamily: MONOSPACE_FONT,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  presetChip: {
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
  },
  presetChipText: {
    fontSize: 12,
    color: '#7DD3FC',
    fontWeight: '600',
  },
  searchInput: {
    backgroundColor: '#0A0F1D',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F8FAFC',
    fontSize: 13,
    height: 40,
    marginBottom: 10,
  },
  procRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  procName: {
    fontSize: 13,
    color: '#F8FAFC',
    fontWeight: '600',
  },
  procPid: {
    fontSize: 11,
    color: '#64748B',
    fontFamily: MONOSPACE_FONT,
    marginTop: 2,
  },
  killBtn: {
    backgroundColor: 'rgba(251, 113, 133, 0.15)',
    borderWidth: 1,
    borderColor: '#FB7185',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  killBtnText: {
    fontSize: 11,
    color: '#FB7185',
    fontWeight: '700',
  },
  portBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  portOpen: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: '#10B981',
  },
  portClosed: {
    backgroundColor: 'rgba(251, 113, 133, 0.15)',
    borderColor: '#FB7185',
  },
  portText: {
    fontSize: 11,
    color: '#F8FAFC',
    fontFamily: MONOSPACE_FONT,
    fontWeight: '600',
  },
  singleInput: {
    backgroundColor: '#0A0F1D',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F8FAFC',
    fontSize: 13,
    height: 44,
    marginBottom: 10,
    fontFamily: MONOSPACE_FONT,
  },
  deviceRowCard: {
    backgroundColor: '#0A0F1D',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  deviceTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  deviceAddress: {
    fontSize: 11,
    color: '#94A3B8',
    fontFamily: MONOSPACE_FONT,
    marginTop: 2,
  },
  emptyText: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    paddingVertical: 14,
  },
  terminalDrawer: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    backgroundColor: '#070C18',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    zIndex: 100,
  },
  terminalDrawerCollapsed: {
    height: 38,
  },
  terminalDrawerExpanded: {
    height: 220,
  },
  terminalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    height: 36,
  },
  terminalDot: {
    color: '#34D399',
    fontSize: 10,
  },
  terminalTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
  },
  terminalCount: {
    fontSize: 11,
    color: '#64748B',
  },
  terminalClearText: {
    fontSize: 11,
    color: '#38BDF8',
    fontWeight: '600',
  },
  terminalToggleText: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '600',
  },
  terminalBody: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  logText: {
    fontSize: 11,
    fontFamily: MONOSPACE_FONT,
    lineHeight: 18,
    marginBottom: 4,
  },
  log_system: { color: '#94A3B8' },
  log_sent: { color: '#38BDF8' },
  log_recv: { color: '#34D399' },
  log_prog: { color: '#F59E0B' },
  log_err: { color: '#FB7185' },
  bottomNav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    backgroundColor: '#0D1527',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  navTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  navTabActive: {
    borderTopWidth: 2,
    borderTopColor: '#38BDF8',
  },
  navIcon: {
    fontSize: 16,
    marginBottom: 2,
  },
  navLabel: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '600',
  },
  navLabelActive: {
    color: '#38BDF8',
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#131E32',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F8FAFC',
    marginBottom: 10,
  },
  modalTitleDanger: {
    color: '#FB7185',
  },
  modalMessage: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 20,
    marginBottom: 20,
  },
});
