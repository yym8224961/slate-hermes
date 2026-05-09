# slate / firmware

ESP-IDF 5.5.x 工程，目标 ESP32-S3。设备形态：4.2" 黑白墨水屏 + 单声道喇叭 + 4 颗按键 + 单节锂电池。开机后从 backend 同步 group 的 frame.img + .pcm 到 LittleFS，按键本地翻页与同步播音。

## 硬件

支持的板：**ZecTrix_Note4_V1.0**（极趣实验室「Ai 便利贴」开源便利贴，jlc-EDA 设计）。本工程**只支持这块板**（pinout、电源拓扑、sdkconfig 都按它固化）。

### 概览

| 项 | 规格 |
|---|---|
| MCU 模组 | ESP32-S3-WROOM-1 **N16R8V**：16 MB Flash QIO + 8 MB Octal PSRAM |
| 显示 | 4.2" 黑白 EPD 400 × 300，控制器 SSD2683，外置电荷泵供电 |
| 音频 | ES8311 单声道 codec + 8 脚差分 D 类 PA + MEMS 麦 |
| 传感 | PCF8563 RTC（VBAT 备份）、GT23SC6699 NFC（NTAG21x） |
| 电池 | 单节 4.2 V 锂电，开关型 1S 充电 IC（默认 1.5 A） |
| 按键 | BOOT (GPIO0) / UP (GPIO39) / DOWN (GPIO18) / 硬复位 SW3 → EN# |
| 接口 | USB Type-C（走 ESP32 内置 USB CDC/JTAG）、4 脚喇叭座、6 脚调试座 |

> ⚠ Flash 是 **QIO**（非 Octal）+ Octal PSRAM。`sdkconfig.defaults` 里 `CONFIG_ESPTOOLPY_OCT_FLASH=n` + `CONFIG_SPIRAM_MODE_OCT=y` 是正确组合。改错会让 bootloader 卡死，需要拆机断电池排线救砖。

### 软锁存开关机

```
USB VBUS ── 充电 IC ── VBAT ── Q5 PMOS ── VIN ── 同步 Buck ── 3V3
                                  ▲
                                  │ 拉低栅极 = 导通
              SW1 (下键)──D3─────┤
              GPIO17 (PWR_ON)─R14─Q6─┤
```

- **开机**：用户按住 SW1（下键）→ Q5 导通 → 系统上电 → 固件拉高 GPIO17 自锁，松开下键也不掉电。
- **开机后必做**：busy-wait GPIO18 拉高（用户松开下键）再交按键驱动接管，否则按键驱动启动会误识别一次「按下」。
- **关机**：拉低 GPIO17 → Q5 关断 → 整机断电。**这是唯一关机方式**。
- **保活**：所有控电源与复用 GPIO（PWR_ON / EPD_PWR_EN / PA_PWR_EN / PA_CTRL / LED_G）写完都立刻 `gpio_hold_en`，让电平在 sleep 与复位过程中不丢。

### 三条 rail

| Rail | 控制脚 | 关掉的副作用 |
|---|---|---|
| VBAT 系统主电（软锁存） | GPIO17 | 整机断电；只剩 PCF8563 RTC 走时 |
| 3V3_EPD（屏） | GPIO6（`EpdSsd1683` 自管） | 屏内电荷泵失效，下次必须重做完整 `EPD_Init()` |
| AVDD_3V3（音频 + I²C 上拉） | GPIO42（`BoardPowerBsp` 管） | I²C 死、ES8311 / PA / MIC 全失能 |

> ⚠ I²C 上拉电阻 R45/R46 接在 AVDD_3V3 rail 上，**不是常驻 3V3**。GPIO42 拉低则三个 I²C 外设全死。任何 I²C 操作前必须先确保 GPIO42 = 高 + `gpio_hold_en`。

### GPIO 映射

```
GPIO0   KEY_ENTER       SW4，确认 + BOOT，低有效；上电瞬间按住进 ROM 下载
GPIO1   STDBY_H         充电 IC LED2，满电时高
GPIO2   CHRG_L          充电 IC LED1，充电时低
GPIO3   LED_G           单颗绿色电源 LED（低有效）
GPIO4   ADC_BAT         ADC1_CH3，VBAT 1:2 分压（软件 ×2 还原）
GPIO5   RTC_INT         PCF8563 INT#，open-drain，低有效
GPIO6   EPD_PWR_EN      拉高 = 给屏供电
GPIO7   NFC_FD          GT23SC6699 场检测，低有效
GPIO8   EPD_BUSY        ⚠ active-low（低 = 忙、高 = 空闲），与 SSD1683 datasheet 相反
GPIO9   EPD_NRES        屏复位
GPIO10  EPD_NDC         屏 D/C
GPIO11  EPD_NCS         屏片选（软件控制，SPI device 配 spics_io_num=-1）
GPIO12  EPD_SCK         SPI3 SCK
GPIO13  EPD_SDA         SPI3 MOSI
GPIO14  I2S_MCLK        256 × fs
GPIO15  I2S_SCLK        BCLK
GPIO16  I2S_ASDOUT      DIN（麦）
GPIO17  PWR_ON          拉高自锁，拉低关机
GPIO18  KEY_DET/PGDN    下键 + 软锁存反馈
GPIO19  USB_DN          USB Type-C D-
GPIO20  USB_DP          USB Type-C D+
GPIO21  NFC_PWR
GPIO38  I2S_LRCK        WS
GPIO39  KEY_PGUP        上键（SW2，⚠ 不是 RTC IO，不能 ext1 唤醒）
GPIO40/41               调试座 J3 预留
GPIO42  PA_PWR_EN       AVDD_3V3 + I²C 上拉的总开关
GPIO43  TXD0            UART0
GPIO44  RXD0            UART0
GPIO45  I2S_DSDIN       DOUT（喇叭）
GPIO46  PA_CTRL         PA U5 CTRL + ES8311 PA_PIN（高 = 出声）
GPIO47  I2C_SDA         ES8311 0x18 / PCF8563 0x51 / GT23SC6699 0x55
GPIO48  I2C_SCL
EN#     SW3 硬复位
```

GPIO 26~37 被 Octal PSRAM 占用，不可作普通 GPIO。这块板 GPIO 已用满，无富余。

### 总线参数

| 总线 | 端口 | 引脚 | 设备 |
|---|---|---|---|
| I²C | I2C_NUM_0 | SDA=47 / SCL=48，标 / 快速模式 | ES8311 (0x18) / PCF8563 (0x51) / GT23SC6699 (0x55) |
| SPI | SPI3_HOST | MOSI=13 SCK=12 CS=11 DC=10 RST=9 BUSY=8，**40 MHz mode 0** | EPD only |
| I²S | I2S_NUM_0 | MCLK=14 BCLK=15 WS=38 DIN=16 DOUT=45，**MCLK = 256 × fs** | ES8311 |
| ADC | ADC1 | CH3 (GPIO4)，12-bit，衰减 12 dB，curve_fitting 校准 | VBAT |

### 电池电量曲线

```
percent = clamp((-V*V + 9016*V - 19189000) / 10000, 0, 100)   # V 单位 mV
# 4200 mV → 100% / 3800 mV → 67% / 3300 mV → 0%
```

单节锂电池现场拟合。换电池要重新拟合或改成查表。

### 墨水屏（SSD2683，400 × 300）

- 每行 50 字节（= ⌈400/8⌉），整帧 **15 000 字节** 1bpp。
- SSD2683 期望 2bpp 输出格式（每像素拆 2 bit），1bpp → 串行打包时每字节膨胀成 2 字节，**实际 SPI 一次刷屏发送 30 KB**。
- 全刷 ~2-3 s（明显黑白翻转），局刷 ~0.3-0.6 s（无闪）。**累计 8 次 partial 后强制一次 full** 清残影（`epd_ssd1683.cc:kPartialBeforeFullCleanup`）。
- BUSY 极性与标准 SSD1683 datasheet 相反（**低 = 忙、高 = 空闲**）。
- 温度补偿写 `0xE6`，根据屏内温度寄存器 `0x40` 分 5 档：≤ 5/10/20/30/127°C → 0xE8 / EB / EE / F1 / F4。60 s 内复用上次温度避免每次 5-10 ms 切 SPI RX 模式开销。
- 3V3_EPD 一旦关掉，屏内电荷泵失效，再次启用必须重做完整 `EPD_Init()`，无法「恢复」。

### 音频（ES8311）

- I²S Master、16-bit、单声道；MCLK = 256 × fs（参考用 16 kHz × 256 = 4.096 MHz）。
- `pa_voltage = 5 V` 是 codec 增益曲线参数（外部 PA 吃 boost 路径 5 V，与板上实际供电对齐）。
- **防「啵」声顺序**：出声前先 enable codec output，再拉高 GPIO46（PA_CTRL）；静音时反过来。`gpio_hold_dis/en` 包住 PA_CTRL 防 PM 切档时 PA 抽搐。

### 休眠与唤醒

- 可作 ext1 深睡唤醒源的 RTC GPIO：0（确认）、5（RTC_INT）、7（NFC_FD）、18（下键）、2 / 1（充电状态）。**GPIO 39（上键）不是 RTC IO**，不能 ext1 唤醒。
- 用户想看上一帧需要先按 DOWN / BOOT 醒，再按 UP 翻。
- **Octal PSRAM 必须开**这几个 workaround，否则休眠漏几 mA：`ESP_SLEEP_FLASH_LEAKAGE_WORKAROUND` / `_PSRAM_LEAKAGE_WORKAROUND` / `_MSPI_NEED_ALL_IO_PU` / `_GPIO_RESET_WORKAROUND`。

## 软件架构

### 启动顺序（`App::Init`）

```
nvs_flash_init + cache::Init（LittleFS mount "storage"）
  → Board::Init（BoardPowerBsp / I2C / ChargeStatus / 三按键 / EpdSsd1683 + LVGL / ADC）
  → AudioPlayer::Init（I2S + ES8311）
  → evt::Init（FreeRTOS xQueue 长度 32）
  → SceneStack::SetContext（epd, audio, read_battery, read_charge, wifi_*）
  → StartUiLoop（8KB pinned core 0，Push BootSplashScene）
  → AttachInputs（按键 → EventBus，组合键 UP+DOWN = 紧急全刷）
  → time_tick_.Start（每分钟一次 MinuteTick 喂状态栏）
  → InitNetwork:
       cred 加载成功 → Wifi.Connect → SNTP → api::Register → SyncService.Start
                       + PostCachedGroupReadyIfAny + PostWakeupKeyEvent
       cred 缺失     → CaptivePortal（SoftAP「Slate-XXXX」+ DNS hijack）
  → SleepManager.Init（IDLE_DEEP_SLEEP_MIN 默认 5 分钟，captive portal 时禁用）
  → esp_pm_configure（80–240 MHz DFS，light_sleep=false）
```

`Run()` 等同 `vTaskDelete(NULL)` —— main task 让出 8 KB 栈，由后台 task 接管：`ui_loop` / `sync_service` / `charge_tick` / `audio_task` / `epd_refresh`。

### Scene 栈（UI 单线程模型）

所有 UI 状态 = 一个 Scene；多个 Scene 用 `SceneStack` 堆叠。栈底永远是 `FrameScene`。

```
FrameScene  ← 栈底，渲染当前 group 的 frame[idx] + 24 px 状态栏
├─ ButtonShort{kUp}                → idx-- (wrap)
├─ ButtonShort{kDown,kEnter}       → idx++ (wrap)
├─ ButtonLong{kEnter}              → push SettingsScene
├─ GroupReady                      → 若 gid 变了重新 Rebind + LoadFrame default
└─ MinuteTick                      → 重读 wifi / battery 喂状态栏

SettingsScene
├─ 子页：VolumePage / DeviceInfoPage / DataSyncPage / FactoryResetPage / FontDemoPage
└─ ENTER 长按 pop 回 FrameScene
```

所有 Scene 方法（OnEnter / OnExit / OnEvent）**只在 ui_loop task** 调用。Scene 内若需切场景，调 `RequestPush/Pop/Replace` 入队，ui_loop 在 `Dispatch` 后调 `ApplyPending`。

### 事件总线（`event_bus.h`）

FreeRTOS xQueue，元素是 trivially-copyable 的 `UiEvent`（不放 `std::string` 与 `vector`，queue 是 byte-copy，带 heap 句柄会 use-after-free；`group.gid` 是定长 `char[32]`）。长度 32，满了 timeout 后丢新事件并打 `ESP_LOGW`。

事件源：按键、`ChargeStatus`、Wifi 断开回调、`SyncService`、`TimeTick`。

### 同步协议（`sync_service.cc`）

后台 task 定时 `POST /api/v1/me/poll`（带 telemetry：battery / rssi / fw_version / current_group / current_frame_seq），拿回 `DeviceState`。`group.etag` 与本地 cache 不一致 → `GET /manifest`（带 `If-None-Match`，304 时跳过）→ 增量拉缺失的 `frames/:seq/image` 与 `frames/:seq/audio` 写 LittleFS（也带 ETag）→ 全量到位后 `evt::Post(GroupReady)`。

主动切组：`api::CycleGroup("next"|"prev")` 或 `api::SelectGroup(gid)`，server 返回新 state，立即 `SyncOnce` 把内容拉下来。

NVS 凭据存 `cred.h::Credentials{wifi_ssid, wifi_pwd, server_url, device_name}`。`http://` 与 `https://` 都支持（mbedTLS dynamic buffer 已开）。

### LittleFS 缓存布局

partition `storage`（subtype `spiffs` 共用）：

```
/littlefs/state.json                            {selected_group_id, last_etag}
/littlefs/groups/{gid}/manifest.json            {group_etag, frame_count, default_idx, frames[]}
/littlefs/groups/{gid}/frames/{idx}.img         15000 字节 1bpp
/littlefs/groups/{gid}/frames/{idx}.pcm         16k mono raw PCM
/littlefs/groups/{gid}/frames/{idx}.caption     UTF-8 单行
```

partition table（`partitions.csv`）：4 MB factory + 12 MB storage（约 270 帧 image + audio）。

### Captive Portal

NVS 无 `slate` namespace 凭据时启动 SoftAP「Slate-XXXX」（XXXX = MAC 后两字节），DNS 全劫持到 `192.168.4.1`，HTTP server 服务三段式表单（WiFi / 服务端 URL / 设备名）。`/submit` 走 `Wifi::TryConnect` 试连验证；成功后写 NVS、AP 关闭、500 ms 后 `esp_restart()`。

```
captive_portal_html.h          三段式 HTML（嵌入固件）
captive_portal.cc              /、/scan、/submit、/done、/exit、catch-all 重定向
dns_hijack.cc                  UDP 53 任意 query 返回 192.168.4.1
```

captive portal 期间 `SleepManager` 禁用 deep sleep，避免用户配网时设备睡着。

## 配置（menuconfig 与 sdkconfig.defaults）

`firmware/main/Kconfig.projbuild` 暴露的运行时可调项：

| 项 | 默认 | 说明 |
|---|---|---|
| `SLATE_DEFAULT_SERVER_URL` | `""` | captive portal 表单预填的服务端 URL |
| `SLATE_AP_SSID_PREFIX` | `Slate` | AP SSID = `{prefix}-{XXYY}`（XXYY = MAC 后 2 字节） |
| `SLATE_DEFAULT_TIMEZONE` | `CST-8` | SNTP 后 `setenv("TZ", ...)` |
| `SLATE_DEFAULT_POLL_INTERVAL_S` | 60 | server 不下发时的兜底 |
| `SLATE_IDLE_DEEP_SLEEP_MIN` | 5 | 闲置 N 分钟且不在充电时进 deep sleep |
| `SLATE_LOG_PLAINTEXT_CRED` | n | ⚠ DEBUG ONLY，开了会把 WiFi 密码写进 UART log |

`sdkconfig.defaults` 里固化的：target = esp32s3、Flash 16MB QIO 80MHz、PSRAM Octal 8MB 80MHz、LVGL 9.5.0（`LV_COLOR_DEPTH_16` + `LV_FONT_MONTSERRAT_48`）、PM enable + DFS auto + TICKLESS_IDLE、`ESP_MAIN_TASK_STACK_SIZE=8192`（默认 3584 不够 LVGL 渲染调用栈）、`SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`。

## 依赖（`main/idf_component.yml`）

```
espressif/button         ~4.1.5      iot_button（本工程包了一层 Button class）
espressif/esp_codec_dev  ~1.5.6      ES8311 runtime
lvgl/lvgl                ~9.5.0      黑白 EPD UI
espressif/esp_lvgl_port  ~2.7.2      lvgl tick / lock helpers
joltwallet/littlefs      ~1.16.0     LittleFS
idf                      >= 5.5
```

`components/xiaozhi-fonts/` 是 fork 出来的本地副本（跳过原 `78/xiaozhi-fonts` 的 emoji 字体，其 `emoji_32/64.c` 用了 LVGL 8 API `lv_imgfont_create`，LVGL 9 改名 `lv_binfont_create` 编译失败）。

字体在 `main/fonts/`：

- `SourceHanSansSC_Regular_slim.c`（生产用，GB2312 6763 字，~ 2.16 MB）
- `FusionPixel_12.c`（FontDemoPage A/B 测试用，89 字 + ASCII，~ 52 KB）
- `tools/gen_fonts.sh` 用 `lv_font_conv` 重新生成（`npm i -g lv_font_conv`）

## 构建

```bash
source $IDF_PATH/export.sh                  # ESP-IDF v5.5.x
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

target 已固化在 `firmware/sdkconfig.defaults`，无需 `idf.py set-target`。

CI 在 `.github/workflows/firmware.yml` 用 `espressif/esp-idf-ci-action@v1` 构建，upload `slate-full.bin` 与 `slate-ota.bin` 作为 artifact。
