# Slate / Firmware

ESP-IDF 5.5.x 工程，目标 ESP32-S3。设备形态：4.2 英寸黑白墨水屏 + 单声道喇叭 + 4 颗按键 + 单节锂电池。

支持的板：**ZecTrix_Note4_V1.0**（极趣实验室「Ai 便利贴」，JLC EDA 开源）。本工程**只支持这块板**，pinout、电源拓扑、sdkconfig 均按此板固化。

## 构建与烧录

```bash
source $IDF_PATH/export.sh                # ESP-IDF v5.5.x
idf.py -C firmware build
idf.py -C firmware -p <serial> flash monitor
```

target 固化在 `sdkconfig.defaults`，无需手动 `idf.py set-target`。CI 上由 `.github/workflows/firmware.yml` 用 ESP-IDF v5.5.2 构建，产物 `slate-full.bin`（merge-bin）与 `slate-ota.bin`（仅 app）以 artifact 形式上传。

## 硬件参考

### 规格

| 项 | 规格 |
|---|---|
| MCU 模组 | ESP32-S3-WROOM-1 N16R8V：16 MB Flash（QIO）+ 8 MB Octal PSRAM |
| 显示 | 4.2 英寸黑白 EPD 400 × 300，SSD2683 控制器，外置电荷泵供电 |
| 音频 | ES8311 单声道 codec + 差分 D 类 PA + MEMS 麦 |
| 传感 | PCF8563 RTC（VBAT 备份）、GT23SC6699 NFC（NTAG21x） |
| 电池 | 单节 4.2 V 锂电，开关型 1S 充电 IC（默认 1.5 A） |
| 按键 | BOOT/GPIO0（确认）/ GPIO39（上翻）/ GPIO18（下翻）/ EN#（硬复位） |
| 接口 | USB Type-C（ESP32 内置 USB CDC/JTAG）、4 脚喇叭座、6 脚调试座 |

> Flash 是 **QIO**（非 Octal）+ PSRAM 是 **Octal**。`sdkconfig.defaults` 里 `CONFIG_ESPTOOLPY_OCT_FLASH=n` + `CONFIG_SPIRAM_MODE_OCT=y` 是正确组合，改错会让 bootloader 卡死。
>
> SSD2683 是实际芯片，命令集与 SSD1683 兼容，所以驱动代码与开源资料里有时也写作 SSD1683。

### 电源拓扑与开关机

```
USB VBUS ── 充电 IC ── VBAT ── Q5 PMOS ── VIN ── 同步 Buck ── 3V3
                                  ▲
                       SW1(下键)──D3─────┤ 拉低栅极 = 导通
                       GPIO17(PWR_ON)─R14─Q6─┤
```

- **开机**：按住 SW1（下键）→ Q5 导通 → 固件拉高 GPIO17 自锁，松手不掉电
- **开机必做**：busy-wait GPIO18 拉高（用户松开下键）再交按键驱动接管，否则按键驱动启动会误识别一次「按下」
- **关机**：拉低 GPIO17 → Q5 断开 → 整机断电（唯一关机方式）
- **保活**：所有控电源 GPIO 写完后立刻 `gpio_hold_en`，防止 sleep / 复位过程中电平丢失

三条 rail：

| Rail | 控制脚 | 关断副作用 |
|---|---|---|
| VBAT 主电（软锁存） | GPIO17 | 整机断电，仅 PCF8563 RTC 靠 VBAT 走时 |
| 3V3_EPD | GPIO6（`EpdSsd1683` 自管） | 屏内电荷泵失效，再次上电须重做完整 `EPD_Init()` |
| AVDD_3V3（音频 + I²C 上拉） | GPIO42（`BoardPowerBsp` 管） | I²C 死，ES8311 / PA / MIC 全失能 |

> I²C 上拉电阻 R45/R46 接在 AVDD_3V3 上，**不是常驻 3V3**。任何 I²C 操作前必须先确保 GPIO42 = 高 + `gpio_hold_en`。

### GPIO 映射

```
GPIO0   KEY_ENTER       SW4 确认 + BOOT，低有效；上电按住进 ROM 下载模式
GPIO1   STDBY_H         充电 IC LED2，满电时高
GPIO2   CHRG_L          充电 IC LED1，充电时低
GPIO3   LED_G           绿色电源 LED（低有效）
GPIO4   ADC_BAT         ADC1_CH3，VBAT 1:2 分压（软件 ×2 还原）
GPIO5   RTC_INT         PCF8563 INT#，open-drain，低有效
GPIO6   EPD_PWR_EN      拉高 = 给屏供电
GPIO7   NFC_FD          GT23SC6699 场检测，低有效
GPIO8   EPD_BUSY        ⚠ active-low（低 = 忙，高 = 空闲），与 SSD1683 datasheet 相反
GPIO9   EPD_NRES        屏复位
GPIO10  EPD_NDC         屏 D/C
GPIO11  EPD_NCS         屏片选（软件控制，SPI device 配 spics_io_num=-1）
GPIO12  EPD_SCK         SPI3 SCK
GPIO13  EPD_SDA         SPI3 MOSI
GPIO14  I2S_MCLK        256 × fs
GPIO15  I2S_SCLK        BCLK
GPIO16  I2S_ASDOUT      DIN（麦）
GPIO17  PWR_ON          拉高自锁，拉低关机
GPIO18  KEY_DET / PGDN  下键 + 软锁存反馈
GPIO19  USB_DN
GPIO20  USB_DP
GPIO21  NFC_PWR
GPIO38  I2S_LRCK        WS
GPIO39  KEY_PGUP        上键（⚠ 非 RTC IO，不能 ext1 唤醒）
GPIO40/41               调试座 J3 预留
GPIO42  PA_PWR_EN       AVDD_3V3 + I²C 上拉总开关
GPIO43  TXD0            UART0
GPIO44  RXD0            UART0
GPIO45  I2S_DSDIN       DOUT（喇叭）
GPIO46  PA_CTRL         PA U5 CTRL + ES8311 PA_PIN（高 = 出声）
GPIO47  I2C_SDA         ES8311 0x18 / PCF8563 0x51 / GT23SC6699 0x55
GPIO48  I2C_SCL
EN#     SW3 硬复位
```

> GPIO 26–37 被 Octal PSRAM 占用，不可作普通 GPIO。这块板 GPIO 已经用满，无富余。

### 总线参数

| 总线 | 端口 | 引脚 | 设备 |
|---|---|---|---|
| I²C | I2C_NUM_0 | SDA=47 / SCL=48，标 / 快速模式 | ES8311 (0x18) / PCF8563 (0x51) / GT23SC6699 (0x55) |
| SPI | SPI3_HOST | MOSI=13 SCK=12 CS=11 DC=10 RST=9 BUSY=8，40 MHz mode 0 | EPD（读温度寄存器时降速到 8 MHz） |
| I²S | I2S_NUM_0 | MCLK=14 BCLK=15 WS=38 DIN=16 DOUT=45，MCLK = 256 × fs | ES8311 |
| ADC | ADC1 CH3 | GPIO4，12-bit，衰减 12 dB，curve_fitting 校准 | VBAT |

### EPD（SSD2683，400 × 300）

- 每行 50 字节（⌈400/8⌉），整帧 **15000 字节** 1bpp
- SSD2683 期望 2bpp 输出格式（每像素拆 2 bit），1bpp → 串行打包时每字节膨胀成 2 字节，**实际 SPI 一次刷屏发送 30 KB**
- 全刷 ~2–3 s（明显闪烁），局刷 ~0.3–0.6 s（无闪）
- 累计 8 次 partial 后强制一次 full 清残影（`epd_ssd1683.cc:kPartialBeforeFullCleanup`）
- BUSY 极性与 SSD1683 datasheet 相反（**低 = 忙，高 = 空闲**）
- 温度补偿写 `0xE6`：读屏内温度寄存器 `0x40` 分 5 档（≤ 5 / 10 / 20 / 30 / 127 °C → `0xE8 / EB / EE / F1 / F4`），60 s 内复用上次温度避免每次切 SPI RX 模式 5–10 ms 开销
- 3V3_EPD 一旦关掉，屏内电荷泵失效，再次启用必须重做完整 `EPD_Init()`，无法「恢复」

### 音频（ES8311）

- I²S Master，16-bit，单声道；MCLK = 256 × fs（16 kHz → 4.096 MHz）
- **消「啵」时序**：codec dev open 后等 100 ms DAC bias 收敛再拉高 GPIO46（PA_CTRL）；切歌时先 `set_out_vol(0)` 静音 20 ms 等 DMA 残留播完，再写新 PCM 并恢复音量
- `pa_voltage = 5 V` 是 codec 增益曲线参数（与板上 boost 路径对齐）

### 电池电量曲线

```
percent = clamp((-V*V + 9016*V - 19189000) / 10000, 0, 100)   # V 单位 mV
# 4200 mV → 100%，3800 mV → 67%，3300 mV → 0%
```

单节锂电现场拟合。换电池需要重新拟合或改成查表。

### 休眠与唤醒

可作 ext1 深睡唤醒源的 RTC GPIO：0（确认）、5（RTC_INT）、7（NFC_FD）、18（下键）、1/2（充电状态）。**GPIO 39（上键）不是 RTC IO**，不能作唤醒源。

Octal PSRAM 必须开以下 sleep workaround，否则休眠漏电几 mA：

```
CONFIG_ESP_SLEEP_FLASH_LEAKAGE_WORKAROUND=y
CONFIG_ESP_SLEEP_PSRAM_LEAKAGE_WORKAROUND=y
CONFIG_ESP_SLEEP_RTC_BUS_ISO_WORKAROUND=y
CONFIG_ESP_SLEEP_GPIO_RESET_WORKAROUND=y
```

## 软件架构

### 启动顺序（`App::Init`）

```
nvs_flash_init + LittleFS mount
  → Board::Init（电源 / I²C / 按键 / EPD + LVGL / ADC）
  → AudioPlayer::Init（I²S + ES8311）
  → evt::Init（FreeRTOS xQueue 长度 32）
  → SceneStack::SetContext → StartUiLoop（core 0，push BootSplashScene）
  → AttachInputs（按键 → EventBus，UP+DOWN 组合键 = 紧急全刷）
  → time_tick_.Start（每分钟 MinuteTick）
  → InitNetwork：
       有 Wi-Fi 凭据 → Wifi.Connect → SNTP → api::Register → SyncService.Start
       无 Wi-Fi 凭据 → CaptivePortal（SoftAP「Slate-XXXX」+ DNS 劫持）
  → SleepManager.Init（默认 5 分钟无操作进深睡，captive portal 期间禁用）
  → esp_pm_configure（80–240 MHz DFS）
```

`Run()` 等同 `vTaskDelete(NULL)`，main task 让出 8 KB 栈，后台 task 接管：`ui_loop` / `slate_sync` / `charge_tick` / `audio_task` / `epd_refresh`。

### Scene 栈

所有 UI 状态用 `SceneStack` 堆叠，栈底始终是 `FrameScene`。**所有 Scene 方法只在 `ui_loop` task 调用**；需切场景时调 `RequestPush / Pop / Replace` 入队，`Dispatch` 后调 `ApplyPending`。

```
FrameScene（栈底）
├─ UP 短按           → 上一帧（环回）
├─ DOWN / ENTER 短按 → 下一帧（环回）
├─ ENTER 长按        → push SettingsScene
├─ GroupReady        → 相册变了重新 Rebind + LoadFrame
└─ MinuteTick        → 刷新状态栏（Wi-Fi / 电量）

SettingsScene
└─ 子页：VolumePage / PollIntervalPage / DataSyncPage / DeviceInfoPage
        / RestartDevicePage / FactoryResetPage
```

### 事件总线

FreeRTOS xQueue（长度 32），元素是 trivially-copyable 的 `UiEvent`。不放 `std::string` / `vector`，`group.gid` 用定长 `char[32]`。队列满时丢新事件并打 `ESP_LOGW`。

事件源：按键、`ChargeStatus`、Wi-Fi 断开回调、`SyncService`、`TimeTick`。

### 同步协议（`SyncService`）

后台 task 周期 `POST /api/v1/me/poll`，header 带 `Authorization: Bearer <device_secret>`，body 含 telemetry：

```json
{ "telemetry": {
    "battery_pct": 85, "rssi_dbm": -56, "fw_version": "0.1.0",
    "current_group": "<gid>", "current_frame_seq": 3 } }
```

响应是 `DeviceState`：

- `group.etag` 与本地 `last_etag` 不一致 → `GET /manifest`（带 `If-None-Match`，304 跳过）→ 增量拉缺失帧 → 全量到位后 `evt::Post(GroupReady)`

**轮询周期**：

| 状态 | 周期 | 说明 |
|---|---|---|
| 已绑定 | 用户偏好 30 s / 1 m / 5 m / 10 m / 15 m / 30 m / 1 h（默认 1 m） | 设置 → 轮询周期里改；NVS key `slate/poll_sec` |
| 未绑定 0–10 m | 10 s | 等用户输码后快速屏切 |
| 未绑定 10–30 m | 30 s | 阶梯退避 |
| 未绑定 30 m–2 h | 60 s | 继续退避 |

未绑定窗口（2 h 内）`SleepManager` 禁深睡，避免用户 claim 后屏幕睡着不响应。超时回退正常休眠策略。

主动切相册：`api::CycleGroup("next"|"prev")` 或 `api::SelectGroup(gid)` → 立即 `SyncOnce`。

### LittleFS 缓存布局

partition：4 MB factory + 12 MB storage（约 270 帧）：

```
/littlefs/state.json                            {selected_group_id, last_etag}
/littlefs/groups/{gid}/manifest.json            {group_etag, frame_count, default_idx, frames[]}
/littlefs/groups/{gid}/frames/{idx}.img         15000 字节 1bpp
/littlefs/groups/{gid}/frames/{idx}.pcm         16 kHz mono raw PCM
/littlefs/groups/{gid}/frames/{idx}.caption     UTF-8 单行
```

### Captive Portal

NVS 无 Wi-Fi 凭据时启动 SoftAP「Slate-XXXX」（XXXX = MAC 后 2 字节），DNS 全劫持到 `192.168.4.1`，HTTP server 服务两段式配网表单：

1. **无线网络** —— SSID + 密码（含扫描列表点选）
2. **服务地址** —— `server_url`，`http://` 与 `https://` 均支持（mbedTLS dynamic buffer 已开）

`/submit` 走 `Wifi::TryConnect` 试连验证，成功后写 NVS、关 AP、500 ms 后 `esp_restart()`。

```
captive_portal_html.h   嵌入固件的两段式 HTML
captive_portal.cc       /、/scan、/submit、/done、/exit、catch-all 重定向
dns_hijack.cc           UDP 53 任意 query 返回 192.168.4.1
```

NVS 凭据结构（`cred.h::Credentials`）：

```cpp
std::string wifi_ssid;
std::string wifi_pwd;
std::string server_url;
std::string device_id;       // 由 register 响应下发
std::string device_secret;   // 同上，64 字符 hex，唯一持有方
```

工厂重置（`cred::Clear`）清整个 namespace；下次启动重新进配网模式 + 重新走 register。

captive portal 期间 `SleepManager` 禁用 deep sleep。

## 配置（menuconfig）

`firmware/main/Kconfig.projbuild` 暴露的运行时项：

| 项 | 默认 | 说明 |
|---|---|---|
| `SLATE_DEFAULT_SERVER_URL` | `""` | captive portal 表单预填的服务端 URL |
| `SLATE_AP_SSID_PREFIX` | `Slate` | AP SSID = `{prefix}-{XXYY}`（XXYY = MAC 后 2 字节） |
| `SLATE_DEFAULT_TIMEZONE` | `CST-8` | SNTP 后 `setenv("TZ", ...)` |
| `SLATE_IDLE_DEEP_SLEEP_MIN` | 5 | 闲置 N 分钟且不在充电时进 deep sleep |
| `SLATE_LOG_PLAINTEXT_CRED` | n | ⚠ DEBUG ONLY，开启会把 Wi-Fi 密码写进 UART log |

`sdkconfig.defaults` 固化的关键项：target = esp32s3、Flash 16 MB QIO、PSRAM Octal 8 MB 80 MHz、LVGL 9.5.0、PM enable + DFS auto + TICKLESS_IDLE、`ESP_MAIN_TASK_STACK_SIZE=8192`、`SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`。

## 依赖（`main/idf_component.yml`）

```
espressif/button         ~4.1.5      iot_button（本工程包了一层 Button class）
espressif/esp_codec_dev  ~1.5.6      ES8311 runtime
lvgl/lvgl                ~9.5.0      黑白 EPD UI
espressif/esp_lvgl_port  ~2.7.2      lvgl tick / lock helpers
joltwallet/littlefs      ~1.16.0     LittleFS 文件系统
idf                      >= 5.5
```

`components/xiaozhi-fonts/` 是 fork 的本地副本（跳过原 `78/xiaozhi-fonts` 的 emoji 字体，其 `emoji_32/64.c` 用了 LVGL 8 API `lv_imgfont_create`，LVGL 9 改名 `lv_binfont_create` 编译失败）。

字体在 `main/fonts/`：

- `SourceHanSansSC_Regular_slim.c`（生产用，GB2312 6763 字，~2.16 MB）
- `FusionPixel_12.c`（生产用 ASCII 子集，状态栏百分比数字，~18 KB）
- `tools/gen_fonts.sh` 用 `lv_font_conv` 重新生成（`npm i -g lv_font_conv`）
