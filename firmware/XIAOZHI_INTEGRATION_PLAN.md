# Xiaozhi Chat Integration Plan

## 目标

将 `/Users/qiujun/Projects/esp32-eink` 的核心小智聊天能力嵌入 Slate 固件，同时继续使用 esp32-eink 配置的小智服务端。Slate 相册仍是主功能，小智作为独立模式存在，两个业务在 UI 状态、音量配置和音频播放逻辑上隔离。

## 已确认约束

- 不做 OTA 版本检查、固件下发、固件下载。
- 不下载 assets。
- 允许通过小智 OTA 地址获取 `activation`、`mqtt`、`websocket`、`server_time`。
- 小智 OTA 地址写死在代码中：`https://api.tenclass.net/xiaozhi/ota/`。
- 不接入 MCP 升级/控制逻辑。收到 MCP 消息只记录并忽略。
- 不做 NVS 迁移兼容，当前项目只有单人使用。
- 设置是全局覆盖层，从相册或小智进入后，退出设置回到来源模式。
- 恢复出厂必须同时恢复 Slate 和小智配置。

## 模式模型

### 相册模式

相册模式保持现有 Slate 行为：

- `BOOT` 单击：相册下一帧。
- `UP` 单击：上一帧。
- `DOWN` 单击：下一帧。
- `UP/DOWN` 长按：切换相册组。
- `BOOT` 长按：进入全局设置。
- `BOOT` 快速双击：进入小智模式。

### 小智模式

小智模式由独立 `ChatScene` 承载，不替换相册根状态，作为场景栈上的模式页。

- 小智待机页进入后立即检查协议配置。
- 已配置时显示“小智待机”。
- 未配置时立即获取 OTA 配置，若需要激活则直接显示激活码，不需要用户再按一次 `BOOT`。
- 激活中后台轮询配置，直到拿到 `mqtt` 或 `websocket` 协议配置。
- 小智模式不支持语音唤醒。

小智模式按键：

- `BOOT` 单击：
  - 待机且已配好协议：开始聊天。
  - 连接/聆听中：停止对话，回小智待机。
  - 小智回复中：发送 abort，打断回复并回到聆听。
  - 配置检查/激活中：no-op，由后台自动检查。
- `BOOT` 快速双击：退出小智模式，回相册模式。
- `BOOT` 长按：进入全局设置页。
- `UP` 单击：小智音量 +1。
- `DOWN` 单击：小智音量 -1。

设置页内 `BOOT` 快速双击不触发相册/小智切换，避免覆盖层误切模式。

## 配置与激活流程

小智配置客户端只向硬编码 OTA 地址发起 POST，请求头参考 esp32-eink：

- `Activation-Version: 1`
- `Device-Id`
- `Client-Id`
- `User-Agent`
- `Accept-Language: zh-CN`
- `Content-Type: application/json`

请求体只发送 Slate 设备基本信息、应用版本、MAC、UUID 和板级信息。

响应只解析并保存：

- `activation.message`
- `activation.code`
- `mqtt.endpoint`
- `mqtt.client_id`
- `mqtt.username`
- `mqtt.password`
- `mqtt.publish_topic`
- `mqtt.keepalive`
- `websocket.url`
- `websocket.token`
- `websocket.version`
- `server_time.timestamp`
- `server_time.timezone_offset`

响应中的固件、assets、升级相关字段全部忽略。

## 聊天状态机

小智业务状态由 `ChatService` 管理：

- `kCheckingConfig`：正在获取小智配置。
- `kAwaitingActivation`：已拿到激活码，等待服务端激活后返回协议配置。
- `kReadyIdle`：小智待机，可按 `BOOT` 开始聊天。
- `kConnecting`：正在建立协议音频通道。
- `kListening`：正在监听用户语音并发送 Opus 音频。
- `kSpeaking`：正在播放服务端 TTS，可按 `BOOT` 打断。
- `kError`：配置、网络或音频错误。

状态变化通过 `UiEventKind::kXiaozhiChanged` 通知 UI，UI 从 `ChatService::Snapshot()` 读取最新状态、文本、激活码和音量。

## 协议方案

协议抽象为 `Protocol`，优先使用 MQTT，若没有 MQTT 配置则使用 WebSocket。

### MQTT

- 使用 `78/esp-ml307` 的 `EspNetwork`、`Mqtt`、`Udp`。
- MQTT 负责文本控制消息。
- UDP 负责 Opus 音频包。
- UDP 音频包按 esp32-eink 的 AES-CTR 逻辑处理。
- 发送 hello 时声明：
  - `format: opus`
  - `sample_rate: 16000`
  - `channels: 1`
  - `frame_duration: 60`
- `features` 为空对象，不注册 MCP 能力。

### WebSocket

- 使用 `78/esp-ml307` 的 `EspNetwork` 和 `WebSocket`。
- WebSocket 同时承载文本和二进制 Opus 音频。
- 支持协议 v1/v2/v3 的二进制包格式。
- WebSocket 对象生命周期内持有 `EspNetwork`，避免底层网络接口悬空。
- `features` 为空对象，不注册 MCP 能力。

### 服务端消息处理

- `tts.start`：进入 speaking，暂停麦克风发送，重置解码队列。
- `tts.stop`：回 listening，重新发送 start listening。
- `tts.sentence_start`：更新助手文本。
- `stt.text`：更新用户文本。
- `llm.emotion`：仅记录到状态文本，不驱动额外 UI/资源。
- `system.reboot`：忽略，不执行 OTA/重启升级链路。
- `mcp`：忽略。

## 音频方案

硬件上 ES8311/I2S 是共享资源，业务上做所有权隔离。

### AudioPlayer

`AudioPlayer` 保持 Slate 相册播放入口，同时增加小智独占接口：

- `BeginChat(int codec_volume)`
- `EndChat(int album_codec_volume)`
- `SetChatVolume(int codec_volume)`
- `ReadChatPcm(int16_t* dest, size_t samples)`
- `WriteChatPcm(const int16_t* data, size_t samples)`
- `IsChatActive()`

小智进入对话后：

- 停止相册当前音频。
- 将 codec 音量切到小智音量。
- 相册 `Play()` 请求在 chat active 期间直接忽略。
- 退出对话时恢复相册音量。

### Xiaozhi AudioService

`AudioService` 使用共享 `AudioPlayer` 读写 PCM。

输入链路：

- 从 ES8311 读取 16 kHz mono 16-bit PCM。
- 按 60 ms 帧编码 Opus。
- 放入 send queue，由 `ChatService` 发送给协议层。

输出链路：

- 接收协议层 Opus 包。
- 按服务端返回 sample rate/frame duration 解码。
- 若服务端是 24 kHz 等非 16 kHz，使用 `esp_audio_effects` 重采样到 16 kHz。
- 写回 `AudioPlayer::WriteChatPcm()` 播放。

## 设置页方案

设置页保持全局入口：

- 相册音量。
- 小智音量。
- 设备信息。
- 重启设备。
- 恢复出厂。

删除“立即同步”入口和对应页面代码。后台启动同步、常规同步逻辑保留。

音量拆分：

- 相册音量保存在 `slate.audio/album_vol`。
- 小智音量保存在 `slate.audio/chat_vol`。
- 设置相册音量时只影响 Slate 相册播放。
- 设置小智音量时只影响小智对话播放；若小智正在对话则实时调整 chat volume。

## NVS 方案

统一后的 NVS 命名空间：

- `slate.net`
  - `ssid`
  - `pwd`
  - `url`
  - `dev_id`
  - `dev_sec`
- `slate.audio`
  - `album_vol`
  - `chat_vol`
- `slate.chat`
  - `uuid`
- `slate.chat.mq`
  - `endpoint`
  - `client_id`
  - `username`
  - `password`
  - `pub_topic`
  - `keepalive`
- `slate.chat.ws`
  - `url`
  - `token`
  - `version`

不保留旧 schema 的迁移兼容逻辑。`cred::Clear()` 会额外擦除旧 `slate` namespace，作为开发期清理。

## 恢复出厂

恢复出厂执行：

- 清除 Wi-Fi 凭据。
- 清除 Slate 服务端绑定信息。
- 清除 `slate.audio`。
- 清除小智 UUID、MQTT、WebSocket 配置。
- 格式化 LittleFS 缓存。
- 延迟后重启。

恢复出厂文案明确提示“小智配置及内容缓存”会被清除。

## 构建与组件

新增依赖：

- `78/esp-ml307`：MQTT/UDP/WebSocket 网络传输。
- `espressif/esp_audio_codec`：Opus 编解码。
- `espressif/esp_audio_effects`：音频重采样。
- `esp_app_format`：读取应用描述生成 User-Agent。
- `mqtt`、`pthread`：传输组件依赖。

新增主要源码：

- `firmware/main/chat/xiaozhi_config_client.*`
- `firmware/main/chat/xiaozhi_settings.*`
- `firmware/main/chat/xiaozhi_protocol.*`
- `firmware/main/chat/xiaozhi_mqtt_protocol.*`
- `firmware/main/chat/xiaozhi_websocket_protocol.*`
- `firmware/main/chat/xiaozhi_audio_service.*`
- `firmware/main/chat/xiaozhi_chat_service.*`
- `firmware/main/scenes/chat/chat_scene.*`
- `firmware/main/storage/nvs_store.*`

## 验证计划

已执行：

- `idf.py build` 通过。
- 生成固件：`firmware/build/slate.bin`。
- 当前镜像大小 `0x289e20`，最小 app 分区 `0x400000`，剩余约 37%。

还需要真机验证：

- 相册模式下 `BOOT` 单击仍切下一帧。
- 相册模式下 `BOOT` 双击进入小智模式。
- 小智未激活时进入小智页立即显示激活码。
- 激活后小智待机页显示可聊天状态。
- 小智待机页 `BOOT` 单击开始聊天。
- 聆听中再次 `BOOT` 单击停止并回待机。
- TTS 播放中 `BOOT` 单击打断并回聆听。
- 小智模式 `BOOT` 双击回相册。
- 小智模式 `BOOT` 长按进设置，退出设置回小智页。
- 小智模式 `UP/DOWN` 调小智音量，不影响相册音量。
- 相册音频播放时进入小智对话会停止相册音频；小智退出后相册播放逻辑恢复。
- 恢复出厂后 Slate 配网、服务端绑定、小智配置和缓存都被清除。

## 风险与后续观察

- ES8311 duplex RX/TX 在实际板级麦克风通路上需要真机确认。若麦克风无输入，优先检查 I2S slot mode 和 ES8311 input gain。
- iot_button 的双击实现理论上不会同时触发单击；若真机出现双击同时翻相册或开始聊天，需要在 `AttachInputs()` 增加短按抑制窗口。
- MQTT UDP 的 AES nonce 解析沿用 esp32-eink 思路，若遇到 strict alignment 平台异常，可改成 `memcpy` 读取网络序字段。
- 小智服务端协议字段变化时，只允许扩展 activation/mqtt/websocket/server_time 解析，不引入固件/assets 下载链路。
