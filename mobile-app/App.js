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
} from 'react-native';

export default function App() {
  // 连接状态
  const [connectionMode, setConnectionMode] = useState('usb');
  const [url, setUrl] = useState('ws://localhost:3001'); // 默认连接 localhost
  const [usbUrl, setUsbUrl] = useState('ws://localhost:3001');
  const [isConnected, setIsConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Tab 菜单切换: 'assets' | 'monitor' | 'netsec' | 'repairs' | 'remote' | 'inspection'
  const [currentTab, setCurrentTab] = useState('assets');

  // 1. 资产数据
  const [assetSpecs, setAssetSpecs] = useState(null);
  const [softwareList, setSoftwareList] = useState([]);
  const [patchesList, setPatchesList] = useState([]);

  // 2. 监控与管理数据
  const [cpu, setCpu] = useState(0);
  const [memory, setMemory] = useState(0);
  const [disk, setDisk] = useState({ percent: 0, free: '0 GB', total: '0 GB', mount: 'C:' });
  const [sysInfo, setSysInfo] = useState({ platform: '-', release: '-', uptime: '-' });
  const [processes, setProcesses] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceSearch, setServiceSearch] = useState('');

  // 3. 网络与安全数据
  const [netResults, setNetResults] = useState(null);
  const [showNetResults, setShowNetResults] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [fwRuleName, setFwRuleName] = useState('');
  const [fwPort, setFwPort] = useState('');

  // 4. 一键修复进度数据
  const [repairProgressLogs, setRepairProgressLogs] = useState([]);
  const [repairExecuting, setRepairExecuting] = useState(false);

  // 5. 远程与文件数据
  const [cmdInput, setCmdInput] = useState('');
  const [cmdOutput, setCmdOutput] = useState('');
  const [runningCmd, setRunningCmd] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [collectingLogs, setCollectingLogs] = useState(false);
  const [downloadLink, setDownloadLink] = useState('');

  // 6. 巡检报表数据
  const [inspectionResult, setInspectionResult] = useState(null);
  const [reportsList, setReportsList] = useState([]);
  const [runningInspection, setRunningInspection] = useState(false);

  // 调试控制台日志
  const [logs, setLogs] = useState([
    { time: getTimestamp(), text: '系统初始化就绪。请选择连接模式建立与 Agent 的连接。', type: 'system' }
  ]);

  const wsRef = useRef(null);
  const pendingRequests = useRef(new Map());
  const logScrollRef = useRef(null);

  // 连接变化时重置
  useEffect(() => {
    resetAllData();
    if (wsRef.current) wsRef.current.close();
    addLog(`已切换为 ${connectionMode === 'wifi' ? 'WLAN 无线' : connectionMode === 'usb' ? 'USB 数据线' : '蓝牙'} 连接模式。`, 'system');
  }, [connectionMode]);

  // 当连接成功时，自动拉取初始资产数据
  useEffect(() => {
    if (isConnected) {
      sendRequest('get_assets');
      sendRequest('get_services');
      sendRequest('get_reports');
    }
  }, [isConnected]);

  // 建立并监听 WebSocket 连接
  function connectToWs(connectUrl) {
    setConnecting(true);
    try {
      const socket = new WebSocket(connectUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        setConnecting(false);
        addLog(`已成功连通设备: ${connectUrl}，进入控制大盘。`, 'recv');
        sendRequest('ping');
      };

      socket.onclose = () => {
        setIsConnected(false);
        setConnecting(false);
        addLog('网络连接关闭。', 'system');
        resetAllData();
        wsRef.current = null;
      };

      socket.onerror = () => {
        setIsConnected(false);
        setConnecting(false);
        wsRef.current = null;
      };

      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
          const { type, event: eventName, request_id, status, data, error } = packet;

          if (type === 'push') {
            handlePush(eventName, data);
          } else if (type === 'response') {
            handleResponse(request_id, status, data, error);
          }
        } catch (e) {
          // ignore
        }
      };
    } catch (err) {
      setConnecting(false);
    }
  }

  // 局域网或 USB 共享网段自动搜寻电脑端 Agent
  async function scanForAgent() {
    addLog('正在自动搜寻 USB 共享网络电脑设备...', 'system');
    setConnecting(true);
    
    // 扫描常见的安卓 USB 热点网段
    const subnets = ['192.168.42', '192.168.43', '192.168.49', '192.168.8', '192.168.137'];
    const hostIds = [2, 3, 4, 5, 6, 7, 8, 129, 130, 131, 132];
    
    let foundUrl = null;
    const promises = [];

    for (const sub of subnets) {
      for (const hid of hostIds) {
        const targetIp = `${sub}.${hid}`;
        const checkUrl = `http://${targetIp}:3001/health`;
        
        const promise = (async () => {
          try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 1200);
            const res = await fetch(checkUrl, { signal: controller.signal });
            clearTimeout(id);
            if (res.ok) {
              const data = await res.json();
              if (data.status === 'ok') {
                foundUrl = `ws://${targetIp}:3001`;
              }
            }
          } catch (e) {}
        })();
        promises.push(promise);
      }
    }

    // 针对本地开发和模拟器的 localhost 检测
    promises.push((async () => {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 1000);
        const res = await fetch('http://localhost:3001/health', { signal: controller.signal });
        clearTimeout(id);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'ok') {
            foundUrl = 'ws://localhost:3001';
          }
        }
      } catch (e) {}
    })());

    await Promise.all(promises);

    if (foundUrl) {
      addLog(`发现可用讲台电脑: ${foundUrl}，正在连通...`, 'system');
      connectToWs(foundUrl);
    } else {
      setIsConnected(false);
      setConnecting(false);
      addLog('未搜寻到已开启 Agent 的电脑。请检查 USB 共享网络是否开启。', 'system');
    }
  }

  // 启动时自动运行扫描
  useEffect(() => {
    const timer = setTimeout(() => {
      scanForAgent();
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  function getTimestamp() {
    const now = new Date();
    return now.toTimeString().substring(0, 8);
  }

  function addLog(text, type = 'system') {
    setLogs(prev => [...prev, { time: getTimestamp(), text, type }]);
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 GB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  // 建立 WebSocket 连接
  function toggleConnection() {
    if (isConnected) {
      if (wsRef.current) wsRef.current.close();
      return;
    }

    if (connectionMode === 'usb') {
      scanForAgent();
      return;
    }

    // Wi-Fi 模式连接
    setConnecting(true);
    addLog(`连接中: ${url}...`, 'system');
    connectToWs(url);
  }

  // 发送指令请求
  function sendRequest(action, params = {}) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('错误: 网络未连接。', 'err');
      return;
    }

    const id = Math.random().toString(36).substring(2, 11);
    const payload = {
      id,
      type: 'request',
      action,
      params,
      timestamp: new Date().toISOString()
    };

    wsRef.current.send(JSON.stringify(payload));
    pendingRequests.current.set(id, { action, params });
    addLog(`[发送指令] 动作: ${action} (ID: ${id})`, 'sent');
  }

  // 处理推送
  function handlePush(event, data) {
    if (event === 'status_update') {
      setCpu(data.cpu.percent);
      setMemory(data.memory.percent);
      
      if (data.disk) {
        setDisk({
          percent: data.disk.percent,
          free: formatBytes(data.disk.free),
          total: formatBytes(data.disk.total),
          mount: data.disk.mount
        });
      }

      setSysInfo({
        platform: data.platform,
        release: data.release,
        uptime: formatUptime(data.uptime)
      });

      if (data.processes) {
        setProcesses(data.processes);
      }
    } else if (event === 'repair_progress') {
      addLog(`[自检修复] ${data.progress}`, 'prog');
      setRepairProgressLogs(prev => [...prev, data.progress]);
    }
  }

  // 处理响应
  function handleResponse(reqId, status, data, error) {
    const req = pendingRequests.current.get(reqId);
    if (!req) return;

    if (status === 'pending') {
      addLog(`[执行中] ${req.action}: ${data?.message || '处理中'}`, 'prog');
      return;
    }

    pendingRequests.current.delete(reqId);

    if (status === 'success') {
      addLog(`[成功] ${req.action} 已顺利完成。`, 'recv');
      
      if (req.action === 'get_assets') {
        setAssetSpecs(data.specs);
        setSoftwareList(data.software);
        setPatchesList(data.patches);
      } else if (req.action === 'get_services') {
        setServices(data);
      } else if (req.action === 'network_detect') {
        setNetResults(data);
        setShowNetResults(true);
      } else if (req.action === 'service_control') {
        sendRequest('get_services'); // reload services
        Alert.alert('操作成功', 'Windows 服务状态已成功变更。');
      } else if (req.action === 'process_kill') {
        sendRequest('system_diagnose'); // reload processes
        Alert.alert('已关闭进程', '指定进程已被成功强制终止。');
      } else if (req.action === 'user_control') {
        Alert.alert('操作成功', '目标电脑的用户账户信息已更改。');
      } else if (req.action === 'firewall_control') {
        Alert.alert('操作成功', '防火墙配置已生效。');
      } else if (req.action === 'remote_cmd') {
        setRunningCmd(false);
        setCmdOutput(data.stdout || data.stderr || '指令已执行，无控制台输出。');
      } else if (req.action === 'collect_logs') {
        setCollectingLogs(false);
        setDownloadLink(data.file);
        Alert.alert('收集日志成功', `日志文件包已创建: \n${data.file}`);
      } else if (req.action === 'trigger_inspection') {
        setRunningInspection(false);
        setInspectionResult(data.data);
        sendRequest('get_reports'); // reload reports
      } else if (req.action === 'get_reports') {
        setReportsList(data);
      } else if (req.action === 'repair_execute') {
        setRepairExecuting(false);
        Alert.alert('自动修复成功', data.message);
      }
    } else if (status === 'error') {
      addLog(`[失败] ${req.action}: ${error?.message || '指令出错'}`, 'err');
      setRepairExecuting(false);
      setRunningCmd(false);
      setCollectingLogs(false);
      setRunningInspection(false);
      Alert.alert('执行指令出错', error?.message || 'Agent 端执行异常，请确认是否以管理员身份运行。');
    }
  }

  function formatUptime(uptimeSec) {
    if (!uptimeSec) return '-';
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    return hrs > 0 ? `${hrs}小时 ${mins}分钟` : `${mins}分钟`;
  }

  function resetAllData() {
    setCpu(0);
    setMemory(0);
    setDisk({ percent: 0, free: '0 GB', total: '0 GB', mount: 'C:' });
    setSysInfo({ platform: '-', release: '-', uptime: '-' });
    setProcesses([]);
    setServices([]);
    setAssetSpecs(null);
    setSoftwareList([]);
    setPatchesList([]);
    setNetResults(null);
    setShowNetResults(false);
    setCmdOutput('');
    setDownloadLink('');
    setInspectionResult(null);
    setReportsList([]);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      
      {/* 头部Logo及状态 */}
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <View style={styles.logoDot} />
          <Text style={styles.headerTitle}>Windows 智能运维助手</Text>
        </View>
        <View style={[styles.statusBadge, isConnected ? styles.badgeConnected : styles.badgeDisconnected]}>
          <Text style={styles.statusText}>{isConnected ? '已连接' : '未连接'}</Text>
        </View>
      </View>

      {/* 1. 连接物理传输模式选择 */}
      <View style={styles.modeSelector}>
        <TouchableOpacity
          style={[styles.modeTab, connectionMode === 'wifi' && styles.modeTabActive]}
          onPress={() => !connecting && setConnectionMode('wifi')}
          disabled={isConnected}
        >
          <Text style={[styles.modeTabText, connectionMode === 'wifi' && styles.modeTabTextActive]}>🌐 Wi-Fi 无线</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeTab, connectionMode === 'usb' && styles.modeTabActive]}
          onPress={() => !connecting && setConnectionMode('usb')}
          disabled={isConnected}
        >
          <Text style={[styles.modeTabText, connectionMode === 'usb' && styles.modeTabTextActive]}>🔌 USB 数据线</Text>
        </TouchableOpacity>
      </View>

      {/* Tab菜单栏 */}
      <View style={styles.tabBarContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll}>
          {[
            { id: 'assets', label: '资产管理' },
            { id: 'monitor', label: '实时监控' },
            { id: 'netsec', label: '网络与安全' },
            { id: 'repairs', label: '一键修复' },
            { id: 'remote', label: '命令与传输' },
            { id: 'inspection', label: '自动巡检' }
          ].map(tab => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.tabButton, currentTab === tab.id && styles.tabButtonActive]}
              onPress={() => setCurrentTab(tab.id)}
            >
              <Text style={[styles.tabButtonText, currentTab === tab.id && styles.tabButtonTextActive]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
        
        {/* 未连接时的提示卡片 */}
        {!isConnected && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>建立 O&M 客户端隧道</Text>
            {connectionMode === 'wifi' ? (
              <View>
                <Text style={styles.guideText}>手机需要和电脑连在同一个路由器局域网下：</Text>
                <View style={styles.connectRow}>
                  <TextInput
                    style={styles.input}
                    value={url}
                    onChangeText={setUrl}
                    placeholder="ws://192.168.1.100:3001"
                    placeholderTextColor="#64748B"
                    autoCapitalize="none"
                  />
                  <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={toggleConnection} disabled={connecting}>
                    {connecting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>连接</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View>
                <View style={styles.stepBox}>
                  <Text style={styles.stepText}>1. 用 USB 数据线将手机连接到电脑。</Text>
                  <Text style={styles.stepText}>2. 打开手机的【系统设置 -> 移动网络 -> 个人热点】开启 <Text style={styles.boldText}>“USB 共享网络”</Text> (Tethering)。</Text>
                  <Text style={styles.stepText}>3. 点击下方按钮，系统将自动搜寻并连通多媒体讲台电脑，即可直接管理！</Text>
                </View>
                <View style={styles.connectRow}>
                  <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1 }]} onPress={toggleConnection} disabled={connecting}>
                    {connecting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>🔍 自动搜寻并一键连接电脑</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* 已连接时展示断开卡片（精简） */}
        {isConnected && (
          <View style={styles.card}>
            <View style={styles.connectRow}>
              <Text style={{ flex: 1, color: '#10B981', fontSize: 13, alignSelf: 'center', fontWeight: '600' }}>
                已通过 {connectionMode === 'usb' ? 'USB 数据线' : 'Wi-Fi'} 成功配对建立连接通道
              </Text>
              <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={toggleConnection}>
                <Text style={styles.btnText}>断开</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ==================== TAB 1: 资产管理 ==================== */}
        {currentTab === 'assets' && (
          <View>
            <Text style={styles.sectionHeader}>电脑基本信息</Text>
            <View style={styles.card}>
              {assetSpecs ? (
                <View style={styles.metadataRows}>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>主机名称:</Text><Text style={styles.metaVal}>{assetSpecs.hostname}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>IP 地址:</Text><Text style={styles.metaVal}>{assetSpecs.ip}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>MAC 地址:</Text><Text style={styles.metaVal}>{assetSpecs.mac}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>操作系统版本:</Text><Text style={styles.metaVal}>{assetSpecs.osName}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>内核版本:</Text><Text style={styles.metaVal}>{assetSpecs.osRelease}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>处理器规格:</Text><Text style={styles.metaVal}>{assetSpecs.cpuModel}</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>物理内存大小:</Text><Text style={styles.metaVal}>{(assetSpecs.ramTotal / (1024*1024*1024)).toFixed(1)} GB</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>主磁盘大小:</Text><Text style={styles.metaVal}>{(assetSpecs.diskTotal / (1024*1024*1024)).toFixed(1)} GB</Text></View>
                  <View style={styles.metaRow}><Text style={styles.metaLbl}>显卡设备:</Text><Text style={styles.metaVal}>{assetSpecs.gpuName}</Text></View>
                </View>
              ) : (
                <Text style={styles.emptyText}>请先连接电脑 Agent 收集资产信息。</Text>
              )}
            </View>

            <Text style={styles.sectionHeader}>软件环境列表 (Top 30)</Text>
            <View style={styles.card}>
              {softwareList.length > 0 ? (
                softwareList.map((sw, index) => (
                  <View key={index} style={styles.listItem}>
                    <Text style={styles.listName}>{sw.name}</Text>
                    <Text style={styles.listSub}>{sw.version}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>暂无已安装软件列表数据。</Text>
              )}
            </View>

            <Text style={styles.sectionHeader}>系统安全更新补丁</Text>
            <View style={styles.card}>
              {patchesList.length > 0 ? (
                patchesList.map((pt, index) => (
                  <View key={index} style={styles.listItem}>
                    <Text style={styles.listName}>{pt.id} - {pt.desc}</Text>
                    <Text style={styles.listSub}>{pt.date}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>暂无系统修补补丁记录。</Text>
              )}
            </View>
          </View>
        )}

        {/* ==================== TAB 2: 实时监控 ==================== */}
        {currentTab === 'monitor' && (
          <View>
            <Text style={styles.sectionHeader}>硬件状态监控</Text>
            <View style={styles.telemetryRow}>
              <View style={[styles.card, styles.telemetryCard]}>
                <Text style={styles.gaugeTitle}>CPU 使用率</Text>
                <Text style={styles.gaugeValue}>{cpu}%</Text>
                <View style={styles.barContainer}>
                  <View style={[styles.barFill, { width: `${cpu}%`, backgroundColor: cpu > 80 ? '#EF4444' : '#3B82F6' }]} />
                </View>
              </View>
              <View style={[styles.card, styles.telemetryCard]}>
                <Text style={styles.gaugeTitle}>内存占用率</Text>
                <Text style={styles.gaugeValue}>{memory}%</Text>
                <View style={styles.barContainer}>
                  <View style={[styles.barFill, { width: `${memory}%`, backgroundColor: memory > 80 ? '#EF4444' : '#10B981' }]} />
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.diskRow}>
                <Text style={styles.diskLabel}>系统盘利用率 ({disk.mount})</Text>
                <Text style={styles.diskValue}>{disk.percent}%</Text>
              </View>
              <View style={styles.barContainer}>
                <View style={[styles.barFill, { width: `${disk.percent}%`, backgroundColor: disk.percent > 90 ? '#EF4444' : '#10B981' }]} />
              </View>
              <Text style={styles.diskDetails}>可用 {disk.free} / 总共 {disk.total}</Text>
            </View>

            <Text style={styles.sectionHeader}>系统服务管理</Text>
            <View style={styles.card}>
              <TextInput
                style={styles.searchBar}
                value={serviceSearch}
                onChangeText={setServiceSearch}
                placeholder="搜索服务名称或描述..."
                placeholderTextColor="#64748B"
              />
              <ScrollView style={{ maxHeight: 250 }}>
                {services.length > 0 ? (
                  services
                    .filter(s => s.name.toLowerCase().includes(serviceSearch.toLowerCase()) || s.displayName.toLowerCase().includes(serviceSearch.toLowerCase()))
                    .slice(0, 15)
                    .map((svc, index) => (
                      <View key={index} style={styles.serviceItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.serviceName}>{svc.displayName}</Text>
                          <Text style={styles.serviceCode}>{svc.name} | {svc.startType}</Text>
                        </View>
                        <View style={styles.serviceRight}>
                          <Text style={[styles.statusTextSmall, svc.status === 'Running' ? styles.greenText : styles.redText]}>
                            {svc.status === 'Running' ? '运行中' : '停止'}
                          </Text>
                          <View style={styles.serviceButtons}>
                            <TouchableOpacity
                              style={styles.actionBadge}
                              onPress={() => sendRequest('service_control', { serviceName: svc.name, action: svc.status === 'Running' ? 'stop' : 'start' })}
                              disabled={!isConnected}
                            >
                              <Text style={styles.actionBadgeText}>{svc.status === 'Running' ? '停止' : '启动'}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.actionBadge, { backgroundColor: '#334155' }]}
                              onPress={() => sendRequest('service_control', { serviceName: svc.name, action: 'restart' })}
                              disabled={!isConnected}
                            >
                              <Text style={styles.actionBadgeText}>重启</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      </View>
                    ))
                ) : (
                  <Text style={styles.emptyText}>未连通，无法获取系统服务列表。</Text>
                )}
              </ScrollView>
            </View>

            <Text style={styles.sectionHeader}>运行进程监控 (Top 15)</Text>
            <View style={styles.card}>
              <ScrollView style={{ maxHeight: 250 }}>
                {processes.length > 0 ? (
                  processes.slice(0, 15).map((proc, index) => (
                    <View key={index} style={styles.processItem}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.procName}>{proc.name} (PID: {proc.pid})</Text>
                        <Text style={styles.procPath} numberOfLines={1}>{proc.path || '系统常驻程序'}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                        <Text style={styles.procCpu}>{proc.cpu}% CPU</Text>
                        <Text style={styles.procMem}>{proc.mem}</Text>
                        <TouchableOpacity
                          style={styles.killBadge}
                          onPress={() => sendRequest('process_kill', { pid: proc.pid })}
                          disabled={!isConnected}
                        >
                          <Text style={styles.killBadgeText}>强制结束</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.emptyText}>无活跃进程数据。</Text>
                )}
              </ScrollView>
            </View>
          </View>
        )}

        {/* ==================== TAB 3: 网络与安全 ==================== */}
        {currentTab === 'netsec' && (
          <View>
            <Text style={styles.sectionHeader}>局域网网络连通性诊断</Text>
            <View style={styles.card}>
              <TouchableOpacity
                style={[styles.btn, styles.btnOutline]}
                onPress={() => sendRequest('network_detect')}
                disabled={!isConnected}
              >
                <Text style={styles.btnOutlineText}>🔍 一键网络连通性扫描</Text>
              </TouchableOpacity>

              {showNetResults && netResults && (
                <View style={{ marginTop: 12 }}>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLbl}>📶 核心 Ping (8.8.8.8):</Text>
                    <Text style={styles.resultVal}>{netResults.ping.status === 'success' ? `${netResults.ping.latency} ms` : '失败'}</Text>
                  </View>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLbl}>🔍 DNS 解析 (google.com):</Text>
                    <Text style={styles.resultVal}>{netResults.dns.status === 'success' ? `${netResults.dns.latency} ms` : '失败'}</Text>
                  </View>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLbl}>🌐 局域网物理网关连通:</Text>
                    <Text style={styles.resultVal}>{netResults.gateway.status === 'success' ? `${netResults.gateway.latency} ms` : '异常'}</Text>
                  </View>
                  <Text style={styles.portsHeader}>内部侦听服务端口：</Text>
                  <View style={styles.portsGrid}>
                    {netResults.ports.map((portObj, index) => (
                      <View key={index} style={[styles.portBadge, portObj.status === 'open' ? styles.portOpen : styles.portClosed]}>
                        <Text style={styles.portText}>:{portObj.port} {portObj.status === 'open' ? '开启' : '关闭'}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>

            <Text style={styles.sectionHeader}>安全用户管理</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>在目标系统创建新的管理员/普通用户：</Text>
              <TextInput
                style={styles.singleInput}
                value={usernameInput}
                onChangeText={setUsernameInput}
                placeholder="账户名称 (例: Administrator)"
                placeholderTextColor="#64748B"
              />
              <TextInput
                style={styles.singleInput}
                value={passwordInput}
                onChangeText={setPasswordInput}
                placeholder="安全密码 (大小写字母+数字)"
                placeholderTextColor="#64748B"
                secureTextEntry
              />
              <View style={styles.btnGrid}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { flex: 1, marginRight: 8 }]}
                  onPress={() => {
                    sendRequest('user_control', { action: 'add', username: usernameInput, password: passwordInput });
                    setUsernameInput('');
                    setPasswordInput('');
                  }}
                  disabled={!isConnected}
                >
                  <Text style={styles.btnText}>创建该账户</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnDanger, { flex: 1 }]}
                  onPress={() => {
                    sendRequest('user_control', { action: 'disable', username: usernameInput });
                    setUsernameInput('');
                  }}
                  disabled={!isConnected}
                >
                  <Text style={styles.btnText}>禁用此用户</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={styles.sectionHeader}>高级防火墙管理规则</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>快速为特定业务端口添加入站通行规则：</Text>
              <TextInput
                style={styles.singleInput}
                value={fwRuleName}
                onChangeText={setFwRuleName}
                placeholder="规则标识名称 (例: NetOps-REST-Server)"
                placeholderTextColor="#64748B"
              />
              <TextInput
                style={styles.singleInput}
                value={fwPort}
                onChangeText={setFwPort}
                placeholder="放行端口号 (例: 3389 远程桌面)"
                placeholderTextColor="#64748B"
                keyboardType="numeric"
              />
              <View style={styles.btnGrid}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { flex: 1, marginRight: 8 }]}
                  onPress={() => {
                    sendRequest('firewall_control', { action: 'add', ruleName: fwRuleName, port: fwPort });
                    setFwRuleName('');
                    setFwPort('');
                  }}
                  disabled={!isConnected}
                >
                  <Text style={styles.btnText}>放行此规则</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnDanger, { flex: 1 }]}
                  onPress={() => {
                    sendRequest('firewall_control', { action: 'delete', ruleName: fwRuleName });
                    setFwRuleName('');
                  }}
                  disabled={!isConnected}
                >
                  <Text style={styles.btnText}>删除规则</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ==================== TAB 4: 一键修复 ==================== */}
        {currentTab === 'repairs' && (
          <View>
            <Text style={styles.sectionHeader}>故障自愈中心</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>电脑出现故障？手机端一键分发自动完成闭环诊断与系统级组件修补：</Text>
              
              <TouchableOpacity
                style={[styles.btn, styles.btnDanger, { marginBottom: 12 }]}
                onPress={() => {
                  setRepairExecuting(true);
                  setRepairProgressLogs([]);
                  sendRequest('repair_execute', { action: 'network' });
                }}
                disabled={!isConnected || repairExecuting}
              >
                <Text style={styles.btnText}>🌐 一键网络深度诊断修复</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btn, styles.btnDanger, { marginBottom: 12, backgroundColor: '#8B5CF6' }]}
                onPress={() => {
                  setRepairExecuting(true);
                  setRepairProgressLogs([]);
                  sendRequest('repair_execute', { action: 'system' });
                }}
                disabled={!isConnected || repairExecuting}
              >
                <Text style={styles.btnText}>🛠 一键系统组件完整修复</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { marginBottom: 4 }]}
                onPress={() => {
                  setRepairExecuting(true);
                  setRepairProgressLogs([]);
                  sendRequest('repair_execute', { action: 'performance' });
                }}
                disabled={!isConnected || repairExecuting}
              >
                <Text style={styles.btnText}>⚡ 一键性能优化与内存释放</Text>
              </TouchableOpacity>
            </View>

            {repairProgressLogs.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>指令分发反馈流</Text>
                <View style={styles.repairLogBox}>
                  {repairProgressLogs.map((item, idx) => (
                    <Text key={idx} style={styles.repairLogText}>✓ {item}</Text>
                  ))}
                  {repairExecuting && <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 8 }} />}
                </View>
              </View>
            )}
          </View>
        )}

        {/* ==================== TAB 5: 命令与文件 ==================== */}
        {currentTab === 'remote' && (
          <View>
            <Text style={styles.sectionHeader}>远程命令执行控制台</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>可在下方运行 cmd 命令并实时返回电脑端命令执行结果：</Text>
              <TextInput
                style={styles.singleInput}
                value={cmdInput}
                onChangeText={setCmdInput}
                placeholder="输入命令: tasklist, systeminfo, ipconfig..."
                placeholderTextColor="#64748B"
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { width: 120 }]}
                onPress={() => {
                  setRunningCmd(true);
                  setCmdOutput('命令发送中，等待 Agent 回传...');
                  sendRequest('remote_cmd', { cmd: cmdInput });
                }}
                disabled={!isConnected || runningCmd}
              >
                {runningCmd ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>发送命令</Text>}
              </TouchableOpacity>

              {cmdOutput ? (
                <View style={styles.terminalBox}>
                  <Text style={styles.terminalText}>{cmdOutput}</Text>
                </View>
              ) : null}
            </View>

            <Text style={styles.sectionHeader}>补丁上传与文件推送</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>可通过网络将本地二进制文件以流的形式写入电脑端 Agent uploads/ 目录：</Text>
              <TextInput
                style={styles.singleInput}
                value={uploadFileName}
                onChangeText={setUploadFileName}
                placeholder="要创建的文件名 (例: patch.bat)"
                placeholderTextColor="#64748B"
              />
              <TouchableOpacity
                style={[styles.btn, styles.btnOutline]}
                onPress={() => {
                  if (!isConnected) return;
                  addLog(`正在模拟上传本地补丁文件: ${uploadFileName}...`, 'system');
                  // Trigger upload dummy post
                  fetch(`${url.replace('ws://', 'http://').replace('3001', '3001')}/upload?name=${uploadFileName}`, {
                    method: 'POST',
                    body: '@echo off\necho "O&M Patch Applied"\npause'
                  }).then(() => {
                    addLog(`文件 ${uploadFileName} 成功上传至 PC 存储区。`, 'recv');
                    Alert.alert('上传成功', '文件推送已成功写入 Agent。');
                  }).catch(() => {
                    addLog('文件上传失败，检查网络链接或端口。', 'err');
                  });
                }}
                disabled={!isConnected || !uploadFileName}
              >
                <Text style={styles.btnOutlineText}>💾 上传推送到电脑</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.sectionHeader}>日志文件一键归档</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>收集 Event 错误、Agent 日志并一键打包为 zip 文件归档：</Text>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={() => {
                  setCollectingLogs(true);
                  sendRequest('collect_logs');
                }}
                disabled={!isConnected || collectingLogs}
              >
                {collectingLogs ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>📦 归档并压缩事件日志包</Text>}
              </TouchableOpacity>

              {downloadLink ? (
                <View style={styles.downloadCard}>
                  <Text style={styles.downloadTitle}>文件已打包完成：</Text>
                  <Text style={styles.downloadText}>{downloadLink}</Text>
                  <Text style={styles.downloadGuide}>已保存在电脑端 reports/ 目录下，可直接提取。</Text>
                </View>
              ) : null}
            </View>
          </View>
        )}

        {/* ==================== TAB 6: 自动巡检 ==================== */}
        {currentTab === 'inspection' && (
          <View>
            <Text style={styles.sectionHeader}>自动巡检引擎</Text>
            <View style={styles.card}>
              <Text style={styles.guideText}>自动收集主机所有状态，生成包含健康报告的 Excel 和 PDF 自检文件：</Text>
              
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={() => {
                  setRunningInspection(true);
                  sendRequest('trigger_inspection');
                }}
                disabled={!isConnected || runningInspection}
              >
                {runningInspection ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>📊 立即生成自动化巡检报告</Text>}
              </TouchableOpacity>

              {inspectionResult && (
                <View style={styles.inspectionSummary}>
                  <Text style={styles.inspTitle}>巡检大盘数据：</Text>
                  <View style={styles.resultItem}><Text style={styles.resultLbl}>CPU:</Text><Text style={reportStyle(inspectionResult.cpu.status)}>{inspectionResult.cpu.val} ({inspectionResult.cpu.status})</Text></View>
                  <View style={styles.resultItem}><Text style={styles.resultLbl}>内存:</Text><Text style={reportStyle(inspectionResult.memory.status)}>{inspectionResult.memory.val} ({inspectionResult.memory.status})</Text></View>
                  <View style={styles.resultItem}><Text style={styles.resultLbl}>磁盘空间:</Text><Text style={reportStyle(inspectionResult.disk.status)}>{inspectionResult.disk.val} ({inspectionResult.disk.status})</Text></View>
                  <View style={styles.resultItem}><Text style={styles.resultLbl}>网络通信:</Text><Text style={reportStyle(inspectionResult.network.status)}>{inspectionResult.network.val} ({inspectionResult.network.status})</Text></View>
                </View>
              )}
            </View>

            <Text style={styles.sectionHeader}>已生成巡检报表文件</Text>
            <View style={styles.card}>
              {reportsList.length > 0 ? (
                reportsList.map((rep, idx) => (
                  <View key={idx} style={styles.reportRow}>
                    <Text style={styles.reportName}>{rep}</Text>
                    <Text style={styles.reportPath}>已归档于 Agent/reports 目录</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>当前无已保存的历史自检报告。</Text>
              )}
            </View>
          </View>
        )}

        {/* 底部控制台输出 (始终展示) */}
        <View style={styles.card}>
          <View style={styles.panelHeader}>
            <Text style={styles.cardTitle}>终端实时事件日志</Text>
            <TouchableOpacity onPress={() => setLogs([])}>
              <Text style={styles.clearBtn}>清空</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.consoleBox}
            ref={logScrollRef}
            onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: true })}
          >
            {logs.map((log, index) => (
              <Text key={index} style={[styles.consoleText, styles[`console_${log.type}`]]}>
                [{log.time}] {log.text}
              </Text>
            ))}
          </ScrollView>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function reportStyle(status) {
  return {
    fontSize: 12,
    fontWeight: '700',
    color: status === '正常' ? '#10B981' : '#F59E0B'
  };
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0A0D14',
  },
  header: {
    height: 54,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3B82F6',
    marginRight: 8,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  badgeDisconnected: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#F3F4F6',
  },
  modeSelector: {
    flexDirection: 'row',
    backgroundColor: '#0E131F',
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    padding: 4,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  modeTabActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
  },
  modeTabText: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '600',
  },
  modeTabTextActive: {
    color: '#3B82F6',
  },
  tabBarContainer: {
    backgroundColor: '#0A0D14',
    borderBottomWidth: 1,
    borderBottomColor: '#1D2433',
  },
  tabScroll: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tabButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  tabButtonActive: {
    backgroundColor: '#3B82F6',
    borderColor: '#3B82F6',
  },
  tabButtonText: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '600',
  },
  tabButtonTextActive: {
    color: '#FFF',
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  card: {
    backgroundColor: 'rgba(17, 22, 34, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    color: '#9CA3AF',
    marginBottom: 12,
  },
  guideText: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 10,
    lineHeight: 16,
  },
  connectRow: {
    flexDirection: 'row',
  },
  input: {
    flex: 1,
    backgroundColor: '#05070A',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F3F4F6',
    fontSize: 13,
    marginRight: 8,
  },
  singleInput: {
    backgroundColor: '#05070A',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F3F4F6',
    fontSize: 13,
    height: 40,
    marginBottom: 10,
  },
  btn: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#3B82F6',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnDanger: {
    backgroundColor: '#EF4444',
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: '#3b82f6',
    backgroundColor: 'transparent',
    width: '100%',
    height: 42,
  },
  btnOutlineText: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: '600',
  },
  btnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  stepBox: {
    backgroundColor: '#05070A',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.03)',
  },
  stepText: {
    fontSize: 11,
    color: '#9CA3AF',
    lineHeight: 18,
    marginBottom: 6,
  },
  boldText: {
    color: '#F3F4F6',
    fontWeight: '700',
  },
  codeBlock: {
    backgroundColor: '#1E293B',
    padding: 6,
    borderRadius: 6,
    marginVertical: 4,
    paddingHorizontal: 10,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#10B981',
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    color: '#64748B',
    marginBottom: 8,
    marginLeft: 2,
  },
  telemetryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  telemetryCard: {
    flex: 1,
    marginHorizontal: 4,
    alignItems: 'center',
  },
  gaugeTitle: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 6,
  },
  gaugeValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F3F4F6',
    marginBottom: 8,
  },
  barContainer: {
    width: '100%',
    height: 6,
    backgroundColor: '#0F172A',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 6,
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  diskRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  diskLabel: {
    fontSize: 12,
    color: '#F3F4F6',
  },
  diskValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#10B981',
  },
  diskDetails: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: '#1E293B',
    marginVertical: 12,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 4,
  },
  metaLbl: {
    fontSize: 11,
    color: '#9CA3AF',
  },
  metaVal: {
    fontSize: 11,
    color: '#F3F4F6',
    fontWeight: '500',
  },
  btnGrid: {
    flexDirection: 'row',
  },
  repairDesc: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 12,
  },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: '#05070A',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: '#1E293B',
  },
  tabText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748B',
  },
  tabTextActive: {
    color: '#F3F4F6',
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  closeBtn: {
    fontSize: 20,
    color: '#9CA3AF',
  },
  clearBtn: {
    fontSize: 11,
    color: '#3B82F6',
    fontWeight: '600',
  },
  resultItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  resultLbl: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  resultVal: {
    fontSize: 12,
    color: '#F3F4F6',
    fontWeight: '600',
  },
  portsHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    marginTop: 10,
    marginBottom: 6,
  },
  portsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  portBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 6,
    marginBottom: 6,
  },
  portOpen: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  portClosed: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  portText: {
    fontSize: 10,
    color: '#F3F4F6',
  },
  consoleBox: {
    height: 120,
    backgroundColor: '#040711',
    borderRadius: 8,
    padding: 8,
  },
  consoleText: {
    fontSize: 10,
    fontFamily: 'monospace',
    lineHeight: 14,
    marginBottom: 4,
  },
  console_system: { color: '#9CA3AF' },
  console_sent: { color: '#60A5FA' },
  console_recv: { color: '#34D399' },
  console_prog: { color: '#FBBF24' },
  console_err: { color: '#F87171' },
  emptyText: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
    paddingVertical: 12,
  },
  metadataRows: {
    flexDirection: 'column',
    gap: 8,
  },
  listItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  listName: {
    fontSize: 11,
    color: '#F3F4F6',
    flex: 1,
    marginRight: 10,
  },
  listSub: {
    fontSize: 10,
    color: '#64748B',
    fontFamily: 'monospace',
  },
  serviceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  serviceName: {
    fontSize: 11,
    color: '#F3F4F6',
    fontWeight: '600',
  },
  serviceCode: {
    fontSize: 9,
    color: '#64748B',
    marginTop: 2,
  },
  serviceRight: {
    alignItems: 'flex-end',
  },
  statusTextSmall: {
    fontSize: 9,
    fontWeight: '700',
    marginBottom: 4,
  },
  greenText: { color: '#10B981' },
  redText: { color: '#EF4444' },
  serviceButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  actionBadge: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  actionBadgeText: {
    fontSize: 9,
    color: '#FFF',
    fontWeight: '700',
  },
  processItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  procPath: {
    fontSize: 8,
    color: '#64748B',
    marginTop: 2,
    maxWidth: 220,
  },
  procCpu: {
    fontSize: 10,
    color: '#3B82F6',
    fontWeight: '700',
  },
  procMem: {
    fontSize: 9,
    color: '#9CA3AF',
    marginTop: 1,
  },
  killBadge: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginTop: 3,
  },
  killBadgeText: {
    fontSize: 8,
    color: '#FFF',
    fontWeight: '700',
  },
  searchBar: {
    backgroundColor: '#05070A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    paddingHorizontal: 12,
    color: '#F3F4F6',
    fontSize: 11,
    height: 34,
    marginBottom: 8,
  },
  repairLogBox: {
    backgroundColor: '#05070A',
    borderRadius: 10,
    padding: 12,
  },
  repairLogText: {
    fontSize: 11,
    color: '#10B981',
    lineHeight: 18,
    marginBottom: 4,
  },
  terminalBox: {
    backgroundColor: '#040711',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  terminalText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#F3F4F6',
    lineHeight: 14,
  },
  downloadCard: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: '#10B981',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  downloadTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#10B981',
  },
  downloadText: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#F3F4F6',
    marginVertical: 4,
  },
  downloadGuide: {
    fontSize: 9,
    color: '#9CA3AF',
  },
  inspectionSummary: {
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.02)',
    padding: 12,
    borderRadius: 10,
  },
  inspTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    marginBottom: 8,
  },
  reportRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  reportName: {
    fontSize: 11,
    color: '#F3F4F6',
  },
  reportPath: {
    fontSize: 9,
    color: '#64748B',
    marginTop: 2,
  },
});
