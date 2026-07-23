import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  FlatList,
} from 'react-native';
import { COLORS } from '../src/theme';

export default function ConnectionCard({
  connectionMode,
  url,
  setUrl,
  usbUrl,
  setUsbUrl,
  isConnected,
  connecting,
  onConnectToggle,
  onScanForAgent,
  historyIps,
  onSelectHistoryIp,
}) {
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const currentUrl = connectionMode === 'usb' ? usbUrl : url;
  const setCurrentUrl = connectionMode === 'usb' ? setUsbUrl : setUrl;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>
          {connectionMode === 'usb' ? '🔌 USB 共享数据线隧道' : '🌐 WLAN 局域网连接配置'}
        </Text>
        {historyIps && historyIps.length > 0 && (
          <TouchableOpacity style={styles.historyBtn} onPress={() => setShowHistoryModal(true)}>
            <Text style={styles.historyBtnText}>📜 历史 IP ({historyIps.length})</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.guideText}>
        {connectionMode === 'usb'
          ? '1. 用 USB 数据线连至电脑并开启【USB 共享网络】。\n2. 运行电脑端 NetOpsAgent.exe（监听端口 3001）。\n3. 点击下方【自动搜寻】或使用固定的 IP 连通。'
          : '1. 确保手机与电脑在同一 Wi-Fi 或局域网内。\n2. 运行电脑端 NetOpsAgent.exe 推荐的局域网 IP。\n3. 点击【一键连接电脑】建立即时通信。'}
      </Text>

      {/* 地址输入与历史切换 */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.textInput}
          value={currentUrl}
          onChangeText={setCurrentUrl}
          placeholder="ws://192.168.2.101:3001"
          placeholderTextColor={COLORS.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!connecting && !isConnected}
        />
      </View>

      {/* 按钮按钮 */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.btn, styles.btnScan, connecting && styles.btnDisabled]}
          onPress={onScanForAgent}
          disabled={connecting || isConnected}
          activeOpacity={0.8}
        >
          {connecting ? (
            <ActivityIndicator size="small" color={COLORS.bgDark} />
          ) : (
            <Text style={styles.btnScanText}>🔍 自动搜寻电脑 Agent</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.btn,
            isConnected ? styles.btnDisconnect : styles.btnConnect,
            connecting && styles.btnDisabled,
          ]}
          onPress={onConnectToggle}
          disabled={connecting}
          activeOpacity={0.8}
        >
          <Text style={styles.btnText}>
            {isConnected ? '断开连接' : '手动连通'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 历史 IP 选择弹窗 */}
      <Modal visible={showHistoryModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>📜 历史连接成功的 IP 记录</Text>
              <TouchableOpacity onPress={() => setShowHistoryModal(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={historyIps}
              keyExtractor={(item, index) => `${item}-${index}`}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.historyItem}
                  onPress={() => {
                    onSelectHistoryIp(item);
                    setShowHistoryModal(false);
                  }}
                >
                  <Text style={styles.historyItemText}>{item}</Text>
                  <Text style={styles.historySelectLabel}>选择</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.primary,
  },
  historyBtn: {
    backgroundColor: COLORS.cardBgElevated,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  historyBtnText: {
    fontSize: 11,
    color: COLORS.primary,
    fontWeight: '600',
  },
  guideText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 12,
    backgroundColor: COLORS.bgDark,
    padding: 10,
    borderRadius: 8,
  },
  inputContainer: {
    marginBottom: 12,
  },
  textInput: {
    backgroundColor: COLORS.bgDark,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.primary,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnScan: {
    backgroundColor: COLORS.primary,
  },
  btnScanText: {
    color: COLORS.bgDark,
    fontWeight: '700',
    fontSize: 13,
  },
  btnConnect: {
    backgroundColor: COLORS.cardBgElevated,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  btnDisconnect: {
    backgroundColor: COLORS.dangerGlow,
    borderWidth: 1,
    borderColor: COLORS.danger,
  },
  btnText: {
    color: COLORS.textPrimary,
    fontWeight: '600',
    fontSize: 13,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxHeight: '60%',
    backgroundColor: COLORS.cardBg,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
    paddingBottom: 8,
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  modalClose: {
    fontSize: 16,
    color: COLORS.textMuted,
    padding: 4,
  },
  historyItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  historyItemText: {
    color: COLORS.primary,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  historySelectLabel: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
  },
});
