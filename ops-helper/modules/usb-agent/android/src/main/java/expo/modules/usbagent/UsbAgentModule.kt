package expo.modules.usbagent

import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.*
import java.io.*
import java.net.HttpURLConnection
import java.net.URL

class UsbAgentModule : Module() {

    companion object {
        private const val TAG = "UsbAgentModule"
        private const val AGENT_PORT = 3001
        private const val ADB_PORT = 5555
    }

    private val usbManager: UsbManager? by lazy {
        appContext.reactContext?.getSystemService(Context.USB_SERVICE) as? UsbManager
    }

    private var deployJob: Job? = null

    override fun definition() = ModuleDefinition {
        Name("UsbAgent")

        Events("onUsbDeviceAttached", "onUsbDeviceDetached", "onAgentReady", "onError", "onDeployProgress")

        /**
         * 获取已连接的 USB 设备列表
         */
        AsyncFunction("getDevices") { promise: Promise ->
            try {
                val manager = usbManager ?: throw Exception("USB Manager is not available")
                val devices = manager.deviceList
                val deviceList = devices.values.map { device ->
                    mapOf(
                        "deviceId" to device.deviceId,
                        "vendorId" to device.vendorId,
                        "productId" to device.productId,
                        "deviceName" to device.deviceName,
                        "productName" to (device.productName ?: "Unknown"),
                        "manufacturerName" to (device.manufacturerName ?: "Unknown")
                    )
                }
                promise.resolve(deviceList)
            } catch (e: Exception) {
                promise.reject("ERROR", e.message, null)
            }
        }

        /**
         * 启动自动部署流程
         * 1. 检测 USB 设备
         * 2. 提取 adb.exe 和 NetOpsAgent.exe 到缓存目录
         * 3. 等待 USB 调试授权
         * 4. 推送 Agent 到电脑
         * 5. 启动 Agent 进程
         * 6. 建立端口转发
         * 7. 检测 Agent 就绪
         */
        AsyncFunction("startAutoDeploy") { promise: Promise ->
            deployJob = CoroutineScope(Dispatchers.IO).launch {
                try {
                    sendProgress("正在检测 USB 设备...")

                    // 1. 检测 USB 设备
                    val manager = usbManager ?: run {
                        sendError("USB Manager 不可用")
                        promise.reject("NO_USB_MANAGER", "USB Manager is not available", null)
                        return@launch
                    }

                    val devices = manager.deviceList.values
                    if (devices.isEmpty()) {
                        sendError("未检测到 USB 设备")
                        promise.reject("NO_DEVICE", "No USB device found", null)
                        return@launch
                    }

                    val device = devices.first()
                    sendProgress("检测到设备: ${device.productName ?: device.deviceName}")

                    // 2. 提取工具文件
                    sendProgress("正在提取 ADB 工具和 Agent...")
                    val cacheDir = appContext.reactContext?.cacheDir?.absolutePath
                        ?: run {
                            sendError("无法获取缓存目录")
                            promise.reject("NO_CACHE", "Cannot get cache directory", null)
                            return@launch
                        }

                    val adbPath = extractAsset("$cacheDir/adb.exe", "tools/adb.exe")
                    val agentPath = extractAsset("$cacheDir/NetOpsAgent.exe", "agent/NetOpsAgent.exe")

                    // 同时提取 ADB 依赖的 DLL
                    extractAsset("$cacheDir/AdbWinApi.dll", "tools/AdbWinApi.dll")
                    extractAsset("$cacheDir/AdbWinUsbApi.dll", "tools/AdbWinUsbApi.dll")

                    sendProgress("工具文件提取完成")

                    // 3. 等待 ADB 授权并检测设备
                    sendProgress("正在连接 ADB，请在电脑上确认 USB 调试授权...")
                    val adbDevices = executeAdbCommand(adbPath, "devices")
                    Log.d(TAG, "ADB devices output: $adbDevices")

                    // 检查是否有设备连接
                    if (!adbDevices.contains("\t")) {
                        // 尝试启动 ADB 服务
                        executeAdbCommand(adbPath, "start-server")
                        Thread.sleep(2000)

                        val retryDevices = executeAdbCommand(adbPath, "devices")
                        if (!retryDevices.contains("\t")) {
                            sendError("ADB 未检测到设备，请检查 USB 调试是否已开启")
                            promise.reject("ADB_NO_DEVICE", "ADB cannot find device. Please enable USB debugging on PC.", null)
                            return@launch
                        }
                    }

                    // 4. 推送 Agent 到电脑
                    sendProgress("正在推送 Agent 到电脑...")
                    val pushResult = executeAdbCommand(adbPath, "push \"$agentPath\" C:\\Windows\\Temp\\NetOpsAgent.exe")
                    Log.d(TAG, "Push result: $pushResult")

                    if (pushResult.contains("error", ignoreCase = true)) {
                        sendError("推送 Agent 失败: $pushResult")
                        promise.reject("PUSH_FAILED", "Failed to push agent: $pushResult", null)
                        return@launch
                    }

                    // 5. 启动 Agent 进程
                    sendProgress("正在启动 Agent...")
                    val shellResult = executeAdbCommand(
                        adbPath,
                        "shell \"C:\\Windows\\Temp\\NetOpsAgent.exe\""
                    )
                    Log.d(TAG, "Shell result: $shellResult")

                    // 给 Agent 一些启动时间
                    Thread.sleep(3000)

                    // 6. 设置端口转发
                    sendProgress("正在设置端口转发...")
                    val forwardResult = executeAdbCommand(adbPath, "forward tcp:$AGENT_PORT tcp:$AGENT_PORT")
                    Log.d(TAG, "Forward result: $forwardResult")

                    // 7. 检测 Agent 就绪
                    sendProgress("正在检测 Agent 就绪状态...")
                    var retries = 10
                    var agentReady = false

                    while (retries > 0 && !agentReady) {
                        try {
                            val url = URL("http://localhost:$AGENT_PORT/health")
                            val conn = url.openConnection() as HttpURLConnection
                            conn.requestMethod = "GET"
                            conn.connectTimeout = 2000
                            conn.readTimeout = 2000

                            val responseCode = conn.responseCode
                            if (responseCode == 200) {
                                agentReady = true
                                Log.d(TAG, "Agent health check passed")
                            }
                            conn.disconnect()
                        } catch (e: Exception) {
                            Log.d(TAG, "Health check attempt failed: ${e.message}")
                        }

                        if (!agentReady) {
                            Thread.sleep(1000)
                            retries--
                        }
                    }

                    if (agentReady) {
                        sendProgress("Agent 已就绪")
                        sendEvent("onAgentReady", mapOf("port" to AGENT_PORT, "status" to "ready"))
                        promise.resolve(mapOf("success" to true, "port" to AGENT_PORT))
                    } else {
                        sendError("Agent 启动超时，请检查电脑防火墙设置")
                        promise.reject("AGENT_TIMEOUT", "Agent startup timeout", null)
                    }

                } catch (e: Exception) {
                    Log.e(TAG, "Deploy failed", e)
                    sendError("部署失败: ${e.message}")
                    promise.reject("DEPLOY_FAILED", e.message, null)
                }
            }
        }

        /**
         * 停止部署流程
         */
        AsyncFunction("stopDeploy") {
            deployJob?.cancel()
        }

        /**
         * 检查 Agent 是否就绪
         */
        AsyncFunction("checkAgentReady") { promise: Promise ->
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val url = URL("http://localhost:$AGENT_PORT/health")
                    val conn = url.openConnection() as HttpURLConnection
                    conn.requestMethod = "GET"
                    conn.connectTimeout = 3000
                    conn.readTimeout = 3000

                    val responseCode = conn.responseCode
                    conn.disconnect()

                    promise.resolve(responseCode == 200)
                } catch (e: Exception) {
                    promise.resolve(false)
                }
            }
        }
    }

    /**
     * 从 assets 提取文件到指定路径
     */
    private fun extractAsset(destPath: String, assetName: String): String {
        val context = appContext.reactContext ?: throw Exception("Context is null")

        // 检查文件是否已存在
        val destFile = File(destPath)
        if (destFile.exists()) {
            Log.d(TAG, "File already exists: $destPath")
            return destPath
        }

        // 确保父目录存在
        destFile.parentFile?.mkdirs()

        // 从 assets 复制文件
        context.assets.open(assetName).use { input ->
            FileOutputStream(destFile).use { output ->
                input.copyTo(output)
            }
        }

        Log.d(TAG, "Extracted $assetName to $destPath")
        return destPath
    }

    /**
     * 执行 ADB 命令
     */
    private fun executeAdbCommand(adbPath: String, args: String): String {
        try {
            val command = "\"$adbPath\" $args"
            Log.d(TAG, "Executing: $command")

            val process = Runtime.getRuntime().exec(command)

            val output = StringBuilder()
            val error = StringBuilder()

            val outputReader = BufferedReader(InputStreamReader(process.inputStream))
            val errorReader = BufferedReader(InputStreamReader(process.errorStream))

            var line: String?
            while (outputReader.readLine().also { line = it } != null) {
                output.append(line).append("\n")
            }

            while (errorReader.readLine().also { line = it } != null) {
                error.append(line).append("\n")
            }

            process.waitFor()

            outputReader.close()
            errorReader.close()

            val result = if (output.isNotEmpty()) output.toString() else error.toString()
            Log.d(TAG, "ADB result: $result")

            return result
        } catch (e: Exception) {
            Log.e(TAG, "ADB command failed", e)
            return "error: ${e.message}"
        }
    }

    /**
     * 发送进度事件
     */
    private fun sendProgress(message: String) {
        Log.d(TAG, "Progress: $message")
        sendEvent("onDeployProgress", mapOf("message" to message))
    }

    /**
     * 发送错误事件
     */
    private fun sendError(message: String) {
        Log.e(TAG, "Error: $message")
        sendEvent("onError", mapOf("message" to message))
    }
}