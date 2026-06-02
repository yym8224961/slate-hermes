     1|# Slate / Firmware
     2|
     3|ESP-IDF 5.5.x 固件，目标芯片 ESP32-S3。当前只支持 **ZecTrix_Note4_V1.0**（极趣实验室「Ai 便利贴」）：4.2 英寸黑白墨水屏、ES8311 音频、MEMS 麦、3 个按键（确认 / 上 / 下）、单节锂电池。
     4|
     5|本目录是独立 ESP-IDF 工程，不属于 Bun workspace。
     6|
     7|## 构建与烧录
     8|
     9|```bash
    10|source $IDF_PATH/export.sh
    11|idf.py -C firmware build
    12|idf.py -C firmware -p <serial> flash monitor
    13|```
    14|
    15|CI 使用 ESP-IDF v5.5.2 构建：
    16|
    17|```bash
    18|idf.py build
    19|idf.py merge-bin -o slate-full.bin
    20|cp build/slate.bin build/slate-ota.bin
    21|```
    22|
    23|target、Flash、PSRAM、分区表已在 `sdkconfig.defaults` 固化，无需手动 `idf.py set-target`。
    24|
    25|## 工程结构
    26|
    27|```text
    28|firmware/
    29|├── CMakeLists.txt
    30|├── partitions.csv              4 MB factory app + 12 MB LittleFS storage
    31|├── sdkconfig.defaults          ESP32-S3 / Flash / PSRAM / PM / TLS / Slate 配置
    32|├── tools/                      字体生成工具
    33|└── main/
    34|    ├── app/                    App 生命周期编排
    35|    ├── bsp/                    板级 GPIO、电源、I2C、EPD、按键、ADC、充电状态
    36|    ├── drivers/
    37|    │   ├── audio/              ES8311 + I2S duplex 音频播放/录音
    38|    │   ├── bus/                I2C 设备封装、总线锁、电源自救 hook
    39|    │   ├── display/            SSD2683/SSD1683-compatible EPD 驱动
    40|    │   └── input/              按键封装
    41|    ├── events/                 boot stage、group sync status、UI 事件与事件总线
    42|    ├── network/                Wi-Fi、SNTP、DNS hijack、captive portal、凭据存储
    43|    ├── power/                  power state、sleep manager、重启/关机、分钟级时钟
    44|    ├── resources/              captive portal HTML 与内置字体
    45|    ├── scenes/                 BootSplash、BgRefresh、Frame、Hermes、Settings 及子页
    46|    ├── startup/                boot mode、首次启动/注册流程
    47|    ├── storage/                LittleFS cache、NVS schema
    48|    ├── sync/                   Slate backend HTTP API client 与 SyncService
    49|    ├── ui/                     状态栏、frame view、menu list、主题
    50|    ├── utils/                  JSON、时间、字节、锁 helper
    51|    └── hermes/                 Hermes 语音对话服务
    52|```
    53|
    54|## 硬件规格
    55|
    56|| 项 | 规格 |
    57|| --- | --- |
    58|| MCU | ESP32-S3-WROOM-1 N16R8V，16 MB QIO Flash + 8 MB Octal PSRAM |
    59|| 显示 | 4.2" 黑白 EPD，400 x 300，SSD2683 控制器，命令兼容 SSD1683 |
    60|| 音频 | ES8311 codec，单声道扬声器，MEMS 麦，差分 D 类 PA |
    61|| 传感 | PCF8563 RTC、GT23SC6699 NFC |
    62|| 电源 | 单节 4.2 V 锂电，软锁存主电源，独立 EPD rail 与音频/I2C rail |
    63|| 按键 | GPIO0 确认 / BOOT，GPIO39 上，GPIO18 下 / 开机，EN 硬复位 |
    64|| 接口 | USB-C CDC/JTAG、喇叭座、调试座 |
    65|
    66|Flash 是 QIO，PSRAM 是 Octal。`CONFIG_ESPTOOLPY_OCT_FLASH=n` 与 `CONFIG_SPIRAM_MODE_OCT=y` 是正确组合。
    67|
    68|## GPIO
    69|
    70|```text
    71|GPIO0   KEY_ENTER       确认 + BOOT，低有效
    72|GPIO1   STDBY_H         充电 IC 满电状态
    73|GPIO2   CHRG_L          充电 IC 充电状态
    74|GPIO3   LED_G           绿色 LED，低有效
    75|GPIO4   ADC_BAT         VBAT 1:2 分压
    76|GPIO5   RTC_INT         PCF8563 INT#
    77|GPIO6   EPD_PWR_EN      EPD rail
    78|GPIO7   NFC_FD          NFC 场检测
    79|GPIO8   EPD_BUSY        active-low，低=忙，高=空闲
    80|GPIO9   EPD_NRES
    81|GPIO10  EPD_NDC
    82|GPIO11  EPD_NCS         软件控制 CS
    83|GPIO12  EPD_SCK
    84|GPIO13  EPD_SDA         SPI MOSI
    85|GPIO14  I2S_MCLK
    86|GPIO15  I2S_SCLK
    87|GPIO16  I2S_ASDOUT      MIC DIN
    88|GPIO17  PWR_ON          主电源软锁存，高=保持供电
    89|GPIO18  KEY_DET / PGDN  下键 + 开机反馈
    90|GPIO19  USB_DN
    91|GPIO20  USB_DP
    92|GPIO21  NFC_PWR
    93|GPIO38  I2S_LRCK
    94|GPIO39  KEY_PGUP        上键，非 RTC IO，不能 ext1 唤醒
    95|GPIO42  PA_PWR_EN       AVDD_3V3：音频 + I2C 上拉
    96|GPIO43  TXD0
    97|GPIO44  RXD0
    98|GPIO45  I2S_DSDIN       喇叭 DOUT
    99|GPIO46  PA_CTRL         PA enable，高=出声
   100|GPIO47  I2C_SDA
   101|GPIO48  I2C_SCL
   102|```
   103|
   104|GPIO 26-37 被 Octal PSRAM 占用，不能用作普通 GPIO。
   105|
   106|## 电源
   107|
   108|主电源软锁存：
   109|
   110|```text
   111|USB/VBAT -> Q5 PMOS -> VIN -> Buck -> 3V3
   112|              ^
   113|              ├─ SW1 / GPIO18 下键拉低栅极：按住开机
   114|              └─ GPIO17 PWR_ON 自锁：固件拉高后松手不断电
   115|```
   116|
   117|三条关键 rail：
   118|
   119|| Rail | 控制 | 说明 |
   120|| --- | --- | --- |
   121|| 主电源 | GPIO17 | 拉低会整机断电；deep sleep 前必须 RTC GPIO hold 高 |
   122|| EPD 3V3 | GPIO6 | 关闭后屏幕内容保留，但 controller/电荷泵失效；醒来需完整 init |
   123|| AVDD_3V3 | GPIO42 | 音频供电 + I2C 上拉；任何 I2C 操作前必须打开并 hold |
   124|
   125|开机阶段必须等待 GPIO18 松开后再交给按键驱动，否则下键会被误识别为一次普通按键。
   126|
   127|## 总线
   128|
   129|| 总线 | 端口 | 引脚 | 设备 |
   130|| --- | --- | --- | --- |
   131|| I2C | `I2C_NUM_0` | SDA=47, SCL=48 | ES8311 0x18、PCF8563 0x51、GT23SC6699 0x55 |
   132|| SPI | `SPI3_HOST` | SCK=12, MOSI=13, CS=11, DC=10, RST=9, BUSY=8 | EPD，40 MHz mode 0 |
   133|| I2S | `I2S_NUM_0` | MCLK=14, BCLK=15, WS=38, DIN=16, DOUT=45 | ES8311 duplex |
   134|| ADC | ADC1 CH3 | GPIO4 | VBAT 分压 |
   135|
   136|## 分区
   137|
   138|[partitions.csv](partitions.csv)：
   139|
   140|```text
   141|nvs      0x9000    0x6000
   142|phy_init 0xf000    0x1000
   143|factory  0x10000   0x400000
   144|storage  0x410000  0xBF0000
   145|```
   146|
   147|`storage` 是 LittleFS，约 12 MB。按每帧 15 KB image + 可选 PCM 估算，可缓存约数百帧。
   148|
   149|## 启动模式
   150|
   151|`boot_mode::Decide()` 根据凭据和唤醒原因决定：
   152|
   153|| 模式 | 条件 | 行为 |
   154|| --- | --- | --- |
   155|| `kPortal` | 没有 Wi-Fi 凭据 | 启动 SoftAP captive portal |
   156|| `kBackgroundRefresh` | RTC timer 唤醒、已有 device secret、且有缓存内容组 | 后台刷新当前动态帧，完成后继续 deep sleep |
   157|| `kFullActive` | 冷启动、按键唤醒、充电唤醒或其他情况 | 显示 UI，联网同步，允许用户操作 |
   158|
   159|`wake_reason` 会随 poll 上报给后端：
   160|
   161|```text
   162|timer | button | power_on | charge | other
   163|```
   164|
   165|## 启动流程
   166|
   167|`App::Init()` 当前顺序：
   168|
   169|```text
   170|nvs_flash_init + LittleFS mount
   171|  -> Board::Init()
   172|  -> AudioPlayer::Init()
   173|  -> evt::Init()
   174|  -> hermes::HermesService::Start()
   175|  -> SceneStack::SetContext()
   176|  -> load credentials + boot_mode::Decide()
   177|  -> SleepManager::Init()
   178|  -> StartUiLoop()
   179|  -> AttachInputs()
   180|  -> StartMinuteTick()
   181|  -> StartSleep()
   182|  -> 按 boot mode 启动 captive portal 或 Wi-Fi + SyncService
   183|  -> esp_pm_configure(80-240 MHz DFS)
   184|```
   185|
   186|`Run()` 直接删除 main task，让 `ui_loop`、`slate_sync`、`audio_play`、EPD refresh 等后台 task 接管。
   187|
   188|## Captive Portal
   189|
   190|没有 Wi-Fi 凭据时：
   191|
   192|- 启动 SoftAP：`{SLATE_AP_SSID_PREFIX}-{MAC后2字节}`，默认 `Slate-XXXX`。
   193|- DNS hijack 所有查询到 `192.168.4.1`。
   194|- HTTP portal 提供两步表单：Wi-Fi SSID/password 与 backend `server_url`。
   195|- 提交后先 `Wifi::TryConnect()` 验证，再保存 NVS 并重启。
   196|
   197|凭据结构：
   198|
   199|```cpp
   200|std::string wifi_ssid;
   201|std::string wifi_pwd;
   202|std::string server_url;
   203|std::string device_id;
   204|std::string device_secret;
   205|```
   206|
   207|首次配网后 `device_secret` 为空，重启进入注册流程。工厂重置会清空凭据，下次开机重新进入 portal。
   208|
   209|## 设备注册与绑定
   210|
   211|联网后：
   212|
   213|1. SNTP 对时，HTTPS 需要有效系统时间。
   214|2. `api::Init(server_url, mac, device_secret)`。
   215|3. 如果 NVS 没有 `device_secret`，调用：
   216|
   217|```text
   218|POST /api/v1/devices
   219|```
   220|
   221|4. 保存后端返回的 `device_id` 与 64 字符 `device_secret`。
   222|5. 屏幕显示 `pair_code`，等待 Web claim。
   223|
   224|后续所有受保护设备 API 都使用：
   225|
   226|```text
   227|Authorization: Bearer ***
   228|```
   229|
   230|如果连续 5 次收到 401，固件会投递 `kSecretInvalid`，在 UI 主线程清除 secret 并重启，走重新注册流程。
   231|
   232|## 同步协议
   233|
   234|`SyncService` 运行在 `slate_sync` task，事件位包括：
   235|
   236|- 普通 poll
   237|- 手动 trigger
   238|- next/prev 切组
   239|- timer wake background refresh
   240|- stop
   241|
   242|轮询周期：
   243|
   244|| 状态 | 周期 |
   245|| --- | --- |
   246|| 已绑定 | 60 秒 |
   247|| 未绑定前 10 分钟 | 10 秒 |
   248|| 未绑定 10-30 分钟 | 30 秒 |
   249|| 未绑定 30 分钟后 | 60 秒 |
   250|
   251|poll telemetry：
   252|
   253|```json
   254|{
   255|  "telemetry": {
   256|    "battery_pct": 85,
   257|    "rssi_dbm": -56,
   258|    "fw_version": "0.1.0",
   259|    "wake_reason": "timer",
   260|    "current_group": "gid",
   261|    "current_content_seq": 3,
   262|    "current_content_etag": "etag",
   263|    "manifest_etag": "etag"
   264|  }
   265|}
   266|```
   267|
   268|同步策略：
   269|
   270|- manifest etag 未变：只写当前 state，触发缓存命中 UI。
   271|- manifest etag 变化：`GET /groups/:gid/manifest`，再增量下载缺失 image/audio。
   272|- 每个资源请求带 `If-None-Match`，后端命中返回 304。
   273|- timer wake 且 manifest 未变时，如果后端返回 `current_content`，只更新当前帧。
   274|- 切组调用 `/devices/current/group/next` 或 `/prev`，然后同步目标组。
   275|
   276|## LittleFS 缓存
   277|
   278|布局：
   279|
   280|```text
   281|/littlefs/state.json
   282|/littlefs/groups/{gid}/manifest.json
   283|/littlefs/groups/{gid}/frames/{idx}.img
   284|/littlefs/groups/{gid}/frames/{idx}.img.etag
   285|/littlefs/groups/{gid}/frames/{idx}.pcm
   286|/littlefs/groups/{gid}/frames/{idx}.pcm.etag
   287|/littlefs/groups/{gid}/frames/{idx}.meta
   288|```
   289|
   290|`FrameMeta` 包含：
   291|
   292|```cpp
   293|status_bar_text
   294|content_etag
   295|image_etag
   296|audio_etag
   297|has_ttl
   298|ttl_sec
   299|```
   300|
   301|完整 manifest 同步使用 per-group staging area：
   302|
   303|1. `BeginFrameStage(gid)`
   304|2. 下载所有缺失 image/audio 到 stage
   305|3. 写 staged meta
   306|4. 全部成功后逐帧 `CommitStagedFrame`
   307|5. 写 manifest 与 state
   308|6. 清理旧帧与旧音频
   309|
   310|这样失败同步不会把已提交缓存写成半更新状态。同步后会按空闲空间和组数量清理旧组，当前配置为至少保留 1 MB，最多缓存 4 个组。
   311|
   312|## UI 与按键
   313|
   314|唯一 UI 消费者是 `ui_loop` task。事件通过 FreeRTOS queue 传递，`UiEvent` 必须保持 trivially-copyable，不允许放 `std::string` 或 owning 容器。
   315|
   316|按键：
   317|
   318|| 操作 | 行为 |
   319|| --- | --- |
   320|| UP 短按 | 上一帧 |
   321|| UP 长按 | 上一个内容组 |
   322|| DOWN 短按 | 下一帧 |
   323|| DOWN 长按 | 下一个内容组 |
   324|| ENTER 短按 | 下一帧 |
   325|| ENTER 长按 | 设置页 |
   326|| ENTER 双击 | Hermes语音页 |
   327|| UP + DOWN 同时按 | 紧急全屏刷新，清残影 |
   328|
   329|Scene：
   330|
   331|```text
   332|BootSplashScene      启动、配网、注册、等待绑定/内容组
   333|BgRefreshScene       timer wake 后台刷新
   334|FrameScene           常规显示与翻页
   335|HermesScene          Hermes语音对话（按确认说话，语音发送到后端 STT→Hermes→TTS）
   336|SettingsScene        设置页
   337|  ├─ VolumePage      音量调节
   338|  ├─ DeviceInfoPage
   339|  ├─ RestartDevicePage
   340|  └─ FactoryResetPage
   341|```
   342|
   343|## EPD
   344|
   345|关键参数：
   346|
   347|- 400 x 300，1bpp packed 帧为 15000 bytes。
   348|- SSD2683 实际刷屏需要 2bpp 传输，1bpp 会膨胀成 30 KB SPI payload。
   349|- 全刷约 2-3 秒，局刷约 0.3-0.6 秒。
   350|- 累计多次 partial 后强制 full cleanup，减少残影。
   351|- BUSY 极性是 active-low：低=忙，高=空闲。
   352|- 读屏内温度后写温度补偿寄存器，60 秒内复用温度，避免每次 RX 切换开销。
   353|
   354|deep sleep 前只等待已有 EPD refresh 完成，不主动全刷；屏幕内容依靠墨水屏双稳态保留。
   355|
   356|## 音频
   357|
   358|`AudioPlayer` 初始化 I2S0 duplex：
   359|
   360|- 16 kHz
   361|- mono
   362|- 16-bit
   363|- MCLK = 256 x fs
   364|- TX 用于内容音频和Hermes下行播放
   365|- RX 用于Hermes麦克风上行
   366|
   367|ES8311 使用 lazy open：
   368|
   369|1. 初始化时创建 codec handle，但不立即 open。
   370|2. 第一次播放或语音进入时 open codec。
   371|3. DAC bias 等 100 ms 后再拉高 GPIO46 PA。
   372|4. 切歌前静音并等待 DMA 残留，减少爆音。
   373|
   374|内容音频格式与后端一致：
   375|
   376|```text
   377|16 kHz mono signed 16-bit little-endian raw PCM
   378|```
   379|
   380|内容播放和Hermes对话共用同一个音量设置。
   381|
   382|## Hermes语音交互
   383|
   384|`hermes/` 子系统：
   385|
   386|- `hermes_service`：语音对话状态机，管理录音、发送、TTS 播放全流程。
   387|- 使用 `AudioPlayer::BeginXiaozhi()` / `ReadXiaozhiPcm()` 独占音频硬件采集麦克风。
   388|- 录音 PCM 经 base64 编码后通过 HTTP POST 发送到后端 `/api/v1/hermes/chat`。
   389|- 后端完成 STT（语音识别）、Hermes AI 对话、TTS（语音合成），返回文本+音频。
   390|- 固件收到响应后在墨水屏显示文字，并通过 `AudioPlayer::WriteXiaozhiPcm()` 播放 TTS 音频。
   391|
   392|进入方式：ENTER 双击打开 `HermesScene`。按确认键开始录音，再按确认键停止并发送。语音活动中阻止 deep sleep。
   393|
   394|## 休眠与唤醒
   395|
   396|`SleepManager` 策略：
   397|
   398|- 默认闲置 10 分钟 deep sleep，可由 `SLATE_IDLE_DEEP_SLEEP_MIN` 配置。
   399|- captive portal 模式禁用 deep sleep。
   400|- USB/充电存在时暂停 deep sleep。
   401|- 未绑定后 2 小时内阻止 deep sleep，方便用户在 Web claim 后设备快速响应；低电量会退出 grace。
   402|- Hermes活动中阻止 deep sleep。
   403|
   404|唤醒源：
   405|
   406|- ENTER / GPIO0
   407|- DOWN / GPIO18
   408|- CHARGE_DETECT / GPIO2
   409|- RTC timer（仅当前动态帧需要定时刷新时启用）
   410|
   411|GPIO39 上键不是 RTC IO，不能作为 deep sleep ext1 唤醒源。
   412|
   413|进入 deep sleep 前：
   414|
   415|1. 停止Hermes、同步和音频。
   416|2. 等待 EPD 当前刷新完成，保存状态栏快照。
   417|3. 关闭 EPD rail。
   418|4. 关闭音频/I2C rail。
   419|5. 使用 RTC GPIO hold 住 GPIO17 主电源。
   420|6. 配置 ext1 和可选 timer。
   421|
   422|## 配置项
   423|
   424|[main/Kconfig.projbuild](main/Kconfig.projbuild)：
   425|
   426|| 项 | 默认 | 说明 |
   427|| --- | --- | --- |
   428|| `SLATE_DEFAULT_SERVER_URL` | 空 | captive portal 服务端 URL 预填值 |
   429|| `SLATE_AP_SSID_PREFIX` | `Slate` | SoftAP SSID 前缀 |
   430|| `SLATE_DEFAULT_TIMEZONE` | `CST-8` | SNTP 后设置的 POSIX TZ |
   431|| `SLATE_IDLE_DEEP_SLEEP_MIN` | `10` | 闲置多少分钟进 deep sleep |
   432|
   433|`sdkconfig.defaults` 还固化：
   434|
   435|- ESP32-S3 target
   436|- 16 MB QIO Flash
   437|- 8 MB Octal PSRAM
   438|- LittleFS 分区表
   439|- LVGL 9.5
   440|- TLS root CA bundle
   441|- mbedTLS dynamic buffer 与 external mem alloc
   442|- DFS 80-240 MHz
   443|- tickless idle
   444|- deep sleep leakage workaround
   445|
   446|## 依赖
   447|
   448|[main/idf_component.yml](main/idf_component.yml)：
   449|
   450|```yaml
   451|espressif/button: ~4.1.5
   452|espressif/esp_codec_dev: ~1.5.6
   453|78/esp-ml307: ~3.6.5
   454|espressif/esp_audio_codec: ~2.4.1
   455|espressif/esp_audio_effects: ~1.2.1
   456|lvgl/lvgl: ~9.5.0
   457|espressif/esp_lvgl_port: ~2.7.2
   458|joltwallet/littlefs: ~1.16.0
   459|idf: ">=5.5"
   460|```
   461|
   462|## 字体
   463|
   464|固件内置字体在 `main/resources/fonts/`：
   465|
   466|- `zfull_16.c`
   467|- `zfull_12.c`
   468|- `font_awesome_14_1.c`
   469|- `font_awesome_30_1.c`
   470|
   471|生成脚本：
   472|
   473|```bash
   474|firmware/tools/gen_zfull_fonts.sh
   475|```
   476|
   477|## 调试要点
   478|
   479|- HTTP base URL 接受 `http://` 和 `https://`；authenticated HTTP 会打印警告。
   480|- HTTPS 需要 SNTP 时间同步，否则证书校验可能失败。
   481|- `/api/v1` 前缀写死在 `sync/api_client.cc`，要与 shared/backend 保持一致。
   482|- EPD BUSY 是低忙高闲，调试新屏或新板时不要按 SSD1683 datasheet 默认极性判断。
   483|- AVDD_3V3 关闭后 I2C 上拉消失，任何 I2C 操作都会失败。
   484|- deep sleep 前 GPIO17 必须切 RTC GPIO hold 高，否则会整机断电，按键唤不醒。
   485|