/**
 * UsbAgent Expo Config Plugin
 *
 * 添加 USB 权限和原生模块配置
 */

const { withAndroidManifest, AndroidConfig, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * 修改 AndroidManifest 添加 USB 权限
 */
function withUsbAndroidManifest(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;

    // 添加 USB 权限
    if (!androidManifest.manifest['$']) {
      androidManifest.manifest['$'] = {};
    }

    // 添加 uses-feature
    if (!androidManifest.manifest['uses-feature']) {
      androidManifest.manifest['uses-feature'] = [];
    }
    androidManifest.manifest['uses-feature'].push({
      $: {
        'android:name': 'android.hardware.usb.host',
        'android:required': 'false',
      },
    });

    // 添加 USB 设备过滤
    const mainActivity = androidManifest.manifest['application'][0]['activity'][0];
    if (!mainActivity['intent-filter']) {
      mainActivity['intent-filter'] = [];
    }

    mainActivity['intent-filter'].push({
      action: [{ $: { 'android:name': 'android.hardware.usb.action.USB_DEVICE_ATTACHED' } }],
    });

    mainActivity['intent-filter'].push({
      action: [{ $: { 'android:name': 'android.hardware.usb.action.USB_DEVICE_DETACHED' } }],
    });

    if (!mainActivity['meta-data']) {
      mainActivity['meta-data'] = [];
    }
    mainActivity['meta-data'].push({
      $: {
        'android:name': 'android.hardware.usb.action.USB_DEVICE_ATTACHED',
        'android:resource': '@xml/device_filter',
      },
    });

    return config;
  });
}

/**
 * 自动写入 device_filter.xml 资源文件
 */
function withUsbDeviceFilter(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res');
      const xmlDir = path.join(resDir, 'xml');
      if (!fs.existsSync(xmlDir)) {
        fs.mkdirSync(xmlDir, { recursive: true });
      }
      const filterPath = path.join(xmlDir, 'device_filter.xml');
      const deviceFilterContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 匹配所有 USB 设备 -->
    <usb-device />
</resources>`;
      fs.writeFileSync(filterPath, deviceFilterContent, 'utf-8');
      return config;
    },
  ]);
}

/**
 * UsbAgent 插件
 */
function withUsbAgent(config) {
  // 添加权限
  config = AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.USB_PERMISSION',
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
  ]);

  // 修改 AndroidManifest
  config = withUsbAndroidManifest(config);

  // 写入 XML 设备过滤器
  config = withUsbDeviceFilter(config);

  return config;
}

module.exports = withUsbAgent;