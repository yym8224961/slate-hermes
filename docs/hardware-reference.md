# ZecTrix Note4 硬件参考

> 板名：**ZecTrix_Note4_V1.0**（极趣实验室"Ai 便利贴"开源便利贴，jlc-EDA 设计）。
> 这块板是固定硬件，本文档只描述硬件事实——不写任何软件框架、版本、配置。开发新固件时所有"芯片是什么、引脚怎么接、电压怎么走、有什么坑"先翻这里。

---

## 1. 概览

* **MCU 模组**：ESP32-S3-WROOM-1，型号 N16R8V → 16 MB Flash QIO + 8 MB Octal PSRAM（Octal 必须，不能改 Quad，硬件决定）。
* **显示**：4.2" 黑白墨水屏 400 × 300，控制器 SSD2683，**外置电荷泵供电**（不是 LCM 内置电源）。
* **音频**：ES8311 单声道 codec + 8 脚差分 D 类 PA + 单颗 MEMS 麦克。
* **传感/外设**：PCF8563 RTC（带 VBAT 备份）、GT23SC6699 NFC（NTAG21x 兼容 Type 2 Tag）。
* **电池**：单节锂离子/锂聚 4.2 V，开关型 1S 充电 IC（默认 1.5 A 充电）。
* **接口**：USB Type-C（接 ESP32 USB CDC/JTAG）、4 颗按键（含一颗硬复位）、6 脚 UART 调试座、4 脚喇叭座、2 脚电池座。
* **开关机**：软锁存按键开关。开机=按住下键；关机=拉低 GPIO17（**没有其他后门**）。

---

## 2. 板载芯片清单

| 类型 | 型号 / 规格 | 总线 / 接口 | 关键参数 |
| --- | --- | --- | --- |
| 主控模组 | **ESP32-S3-WROOM-1 N16R8V**（41 脚） | — | 16 MB Flash + 8 MB Octal PSRAM；Octal 模式 GPIO33–37 占用，不可作普通 GPIO |
| 音频 codec | **ES8311**（U3） | I²C `0x18` + I²S | 单声道 16 bit；MCLK 多倍率（典型 256×fs）；模拟侧供电 = AVDD_3V3 |
| 喇叭差分 PA | **8 脚 SOP**（U5），CTRL/Bypass/INP/INN/VON/VCC/GND/VoP | 模拟差分 In/Out | 直接吃 ES8311 差分输出；CTRL 引脚 = ESP32 GPIO46 |
| 麦克风 | **MEMS 4 脚**（MIC1：OUT/GND/GND/VDD） | 模拟单端 | 接 ES8311 MIC1P；AVDD_3V3 供电 |
| 墨水屏 | 4.2" 400 × 300 黑白，**SSD2683**，FPC 26 脚 | SPI3 40 MHz mode 0 | **外置电荷泵**：D5/D6/D7 + 电感 L2 + 开关管 Q8 → VSH/VSL/PREVGH/PREVGL/VCOM；GDR 反馈 |
| RTC | **NXP PCF8563**（U7）+ 32.768 kHz 晶振 X1 | I²C `0x51` + INT# | **VBAT 备份**：D8/D9 二极管 OR 接 3V3 与 VBAT，关机后仍走时（典型 0.25 µA） |
| NFC | **GT23SC6699**（U6，9 脚 SOP+EP） | I²C `0x55` + FD + Power gate | NTAG21x 兼容；天线 LA/LB + 50 pF 谐振电容；用户区 880 B（block 0x01..0x37，每 block 16 B） |
| 充电管理 IC | **8 脚 SOP+EP 同步开关型 1S 充电 IC**（U1） | 模拟 + 2 根 GPIO 状态线 | ISET 选档：NC=2.0 A / 1.4 kΩ=2.4 A / **2.4 kΩ=1.5 A 默认** / 4.3 kΩ=1.0 A；CC/CV，截止 4.2 V；行为符合 TP4056/SY697x 同款（充电时 LED1 低、满电 LED2 高，无电池时两线 ~1 Hz 交替） |
| 系统 3.3 V 电源 | **同步 Buck**（U2，5 脚 EN/GND/SW/VIN/FB）+ 电感 L3 + 反馈分压 R31/R32 | VIN → 3.3 V | Vout = 0.788 × (3.09 M + 1 M) / 1 M = **3.22 V**，I_max **1.2 A** |
| AVDD_3V3 rail（音频/MIC/PA/I²C 上拉） | PMOS 高边开关 Q3/Q4 + 磁珠 FB1，由 GPIO42 (PA_PWR_EN) 控制 | rail | **I²C 上拉电阻 R45/R46 接在这条 rail 上**——这条 rail 一关，整条 I²C 死 |
| 3V3_EPD rail | PMOS 高边开关 Q6/Q7，由 GPIO6 (EPD_PWR_EN) 控制 | rail | 给屏数字侧 + 屏内电荷泵基准 |
| 电池电压采样 | 板上 1:2 电阻分压 → ADC1_CH3 (GPIO4) | ADC | 软件 ×2 还原；电量 = 二阶多项式 |
| 电源 LED | 单颗绿色 LED1 + R35 | GPIO3 (LED_G) | 上拉到 3V3，**低有效**（GPIO3 拉低 = 亮） |
| Type-C 接口 | 标准 USB Type-C 24 脚（USB1） | USB | DP/DN → ESP32 GPIO19/20（USB CDC/JTAG）；VBUS → 充电 IC VIN |
| 接口 J1 | 2 脚电池座 | — | VBAT / GND |
| 接口 J2 | 4 脚喇叭座 | — | PA 差分输出 AOUT_P / AOUT_N |
| 接口 J3 | 6 脚调试座 | UART | 3V3 / GND / TXD0 / RXD0 / GPIO40 / GPIO41 + 抓 STDBY_H / CHRG_L 用 |

---

## 3. GPIO 映射表（与原理图 ESP32 模组逐脚核对）

```
GPIO0   KEY_ENTER（SW4，确认键 + BOOT，低有效）
GPIO1   STDBY_H        充电 IC LED2 输出，满电时高
GPIO2   CHRG_L         充电 IC LED1 输出，充电时低
GPIO3   LED_G          单颗绿色电源 LED（低有效）
GPIO4   ADC_BAT        ADC1_CH3，VBAT 1:2 分压
GPIO5   RTC_INT        PCF8563 INT#，open-drain，低有效
GPIO6   EPD_PWR_EN     拉高 = 给屏供电
GPIO7   NFC_FD         GT23SC6699 场检测，低有效
GPIO8   EPD_BUSY       屏忙信号（输入，**active-low：低=忙、高=空闲**）
GPIO9   EPD_NRES       屏复位
GPIO10  EPD_NDC        屏数据/命令
GPIO11  EPD_NCS        屏片选（软件控制）
GPIO12  EPD_SCK        SPI3 SCK
GPIO13  EPD_SDA        SPI3 MOSI
GPIO14  I2S_MCLK
GPIO15  I2S_SCLK       (BCLK)
GPIO16  I2S_ASDOUT     (DIN，麦克输入路径)
GPIO17  PWR_ON         VBAT 软锁存输出（拉高=自锁；拉低=关机）
GPIO18  KEY_DET/PGDN   下键 + 软锁存按键反馈（输入，低有效）
GPIO19  USB_DN         USB Type-C D-
GPIO20  USB_DP         USB Type-C D+
GPIO21  NFC_PWR        拉高 = 给 NFC 上电
GPIO38  I2S_LRCK       (WS)
GPIO39  KEY_PGUP（SW2，上键，低有效）
GPIO40  调试座 J3 预留
GPIO41  调试座 J3 预留
GPIO42  PA_PWR_EN      AVDD_3V3 域 + I²C 上拉电源（关掉 = I²C 死）
GPIO43  TXD0           UART0 TX（J3）
GPIO44  RXD0           UART0 RX（J3）
GPIO45  I2S_DSDIN      (DOUT，喇叭输出路径)
GPIO46  PA_CTRL        外部 PA U5 CTRL + ES8311 PA_PIN（同一根线）
GPIO47  I2C_SDA
GPIO48  I2C_SCL

EN#     SW3 硬复位键

GPIO26~37：PSRAM Octal 占用，不可作普通 GPIO
```

**这块板的 GPIO 已经用满**，没有富余可扩。

> 注意 strapping 引脚：
> * GPIO0：上电瞬间被按住会进 ROM 下载模式（这正好是确认键，所以正常运行没事，但带电按住复位会进下载）。
> * GPIO45/46/3：strapping 引脚，上电瞬间不要被外部强拉电平。

---

## 4. 总线参数

| 总线 | 端口 | 引脚 | 时钟 / 模式 | 设备（地址） |
| --- | --- | --- | --- | --- |
| I²C | I2C_NUM_0 | SDA=47 / SCL=48 | 标准 / 快速模式（典型 100/400 kHz）| ES8311 (`0x18`) / PCF8563 (`0x51`) / GT23SC6699 (`0x55`) |
| SPI | SPI3_HOST | MOSI=13 / SCK=12 / CS=11(软) / DC=10 / RST=9 / BUSY=8 | 40 MHz mode 0，DMA 自动 | EPD only |
| I²S | I2S_NUM_0 | MCLK=14 / BCLK=15 / WS=38 / DIN=16 / DOUT=45 | Master，16 bit；ES8311 要求 MCLK=256×fs | ES8311 |
| ADC | ADC1 | CH3 (GPIO4) | 12-bit, 衰减 12 dB（量程 ~0–3.1 V），需要 curve_fitting 校准 | VBAT 分压 |

**I²C 上拉位置（必读）**：上拉电阻 R45/R46 接在 **AVDD_3V3 rail（受 GPIO42 控制）** 上，**不是常驻 3V3**。意味着：
* GPIO42 拉低 → I²C 总线没上拉 → 三个 I²C 外设全死。
* 任何代码序列在做 I²C 之前，必须先确保 GPIO42 是高的（直接拉高 + `gpio_hold_en`）。
* 想关 audio rail 省电，要先把所有 I²C 工作做完，醒来后第一件事是把 GPIO42 拉回来再做 I²C。
* 想让 I²C 完全独立于 audio，需要飞线把 R45/R46 上拉端改到 3V3。

---

## 5. 电源系统

### 5.1 电源拓扑

```
USB VBUS ─┬─► 充电 IC U1 (1S Switching Charger)
          │      ├─ BAT pin ──► VBAT (锂电正极，单节)
          │      ├─ LED1 (CHRG_L) ──► GPIO2，充电时低
          │      └─ LED2 (STDBY_H) ──► GPIO1，满电时高
          │
VBAT ─────┴─► Q5 PMOS 软锁存 ──► VIN ──► U2 同步 Buck ──► 3V3 (常驻)
                                                              │
                                          D8/D9 OR ──► PWR_RTC (PCF8563 VDD，永远在线)
                                                              │
                                      GPIO42=PA_PWR_EN ──► AVDD_3V3 rail
                                                              ├─► ES8311 PVDD/AVDD/DVDD
                                                              ├─► 差分 PA U5 VCC
                                                              ├─► MIC1 VDD
                                                              └─► I²C 上拉 R45/R46  ⚠
                                      GPIO6 =EPD_PWR_EN ──► 3V3_EPD rail
                                                              └─► 屏模组（数字 + 内部电荷泵基准）
                                      GPIO21=NFC_PWR    ──► PMOS ──► NFC VDD
                                      GPIO46=PA_CTRL    ──► PA U5 CTRL（高=出声）
                                      GPIO3 =LED_G      ──► LED1 (低有效)
```

| Rail | 控制脚 | 关掉的副作用 |
| --- | --- | --- |
| VBAT 系统主电源（软锁存） | GPIO17 | 整机断电；只剩 RTC 走时 |
| 3V3_EPD（屏） | GPIO6 | 屏内电荷泵失效，所有屏命令失败；下次必须重做完整 `EPD_Init()` |
| AVDD_3V3（音频 + I²C 上拉） | GPIO42 | I²C 死、ES8311 / PA / MIC 失能 |
| PA U5（喇叭功放） | GPIO46 | 静音（防"啵"声） |
| NFC VDD | GPIO21 | NFC 失能 |
| PWR_RTC | 不可控 | — |

### 5.2 软锁存开关机（关键）

```
                 VBAT
                   │
                   └──► Q5 PMOS pass ──► VIN（系统）
                              ▲
                              │ 栅极拉低 = 导通
                              │
       SW1 (下键) ──── D3 ────┤
                              │
       GPIO17 (PWR_ON) ── R14 ── Q6 ──┤ 也能拉低 Q5 栅极
                              │
       Q5 栅极 ── 上拉电阻 ── VBAT
                              │
                              ▼
                          R15 ──► GPIO18 (KEY_DET/PGDN)
                                   既当下键，也当上电检测
```

* **开机**：用户按住下键 SW1 → 经 D3 把 Q5 栅极拉到 GND → Q5 导通 → 整机上电 → 固件开机后立刻拉高 GPIO17 → 经 Q6 继续把 Q5 栅极拉低 → 自锁，松开下键也不掉电。
* **开机后必做**：busy-wait 等 GPIO18 拉高（用户松开下键），再交给按键驱动接管。否则按键驱动一启动就误识别一次"按下"。
* **关机**：固件拉低 GPIO17 → Q6 不再下拉 Q5 栅极 → Q5 关断 → 整机断电。**这是唯一关机方式**。
* **保活**：所有控制电源/复用功能的 GPIO（PWR_ON、EPD_PWR_EN、PA_PWR_EN、PA_CTRL、LED_G）写完都立刻 `gpio_hold_en`，让电平在 sleep / 复位过程中不丢。

---

## 6. 电池与充电

### 6.1 电压采样

* **通道**：ADC1_CH3 (GPIO4)，12-bit，衰减 12 dB（量程 ~0–3.1 V），用曲线拟合校准（`adc_cali_curve_fitting`）。
* **分压**：板上 1:2 → 软件读到 mV 后 ×2 还原。
* **采样策略**：连读多次取均值（参考固件取 10 次）。

### 6.2 电压 → 电量百分比（参考固件曲线）

```
percent = (-V*V + 9016*V - 19189000) / 10000    (V 单位 mV)
percent = clamp(percent, 0, 100)
```

* 4200 mV → ≈ 103 → 100%
* 3800 mV → ≈ 67%
* 3300 mV → ≈ -33 → 0%

这是单节 4.2 V/3.3 V 锂离子电池的现场拟合，**换电池要重新拟合或改成查表**。

### 6.3 充电状态（CHRG_L = GPIO2 低有效；STDBY_H = GPIO1 高有效）

| 状态 | 触发条件（参考固件去抖逻辑，可改） |
| --- | --- |
| `kNoPower`（USB 未插） | 1 s 内既没看到 CHRG_L=低，也没看到 STDBY_H=高 |
| `kCharging` | CHRG_L 持续低 ≥ 400 ms |
| `kFull` | STDBY_H 持续高 ≥ 400 ms |
| `kNoBattery` | 1.5 s 窗口内两根线 ~1 Hz 交替（IC 未检测到电池时的固有特征） |

### 6.4 充电参数

* **充电电流**：板上 ISET = **2.4 kΩ → 1.5 A**（默认）。改 ISET：NC=2.0 A / 1.4 kΩ=2.4 A / 4.3 kΩ=1.0 A。换电池时确认 C 率能不能吃 1.5 A。
* **截止电压**：4.2 V（CC/CV）；截止电流由 IC 内部决定，典型 1/10 ICHG。
* **NTC 引脚**：U1 引脚 1 接出来给电池温度保护，板上是否串热敏由 BOM 决定（参考固件不读 NTC）。

---

## 7. 墨水屏（SSD2683，4.2" 400×300）

### 7.1 控制器接口

* **SPI**：MOSI=13 / SCK=12 / CS=11(软) / DC=10 / RST=9 / BUSY=8，**SPI3_HOST，40 MHz mode 0，DMA 自动**。
* **CS 软件控制**：SPI device 配 `spics_io_num = -1`，由 GPIO11 手动驱动（避免片选时序冲突）。
* **BUSY**：**低电平表示屏忙、高电平表示空闲（active-low）**——这块板的 BUSY 极性与标准 SSD1683 datasheet 相反，与该模组实测一致。所有命令前后都要 poll 这根脚直到**拉高**才算操作完成。

### 7.2 模组电源（外置电荷泵）

3V3_EPD 一路给屏数字侧，屏旁边的电荷泵电路（电感 L2 + 开关管 Q8 + 二极管 D5/D6/D7 + 多颗大电容）由屏的 **GDR** 引脚反馈驱动，生成：

| 引脚 | 用途 |
| --- | --- |
| VSH | 栅极正高压（黑像素驱动） |
| VSL | 栅极负高压（白像素驱动） |
| PREVGH | 共用栅极正高压预充 |
| PREVGL | 共用栅极负高压预充 |
| VCOM | 公共电极偏置 |
| RESE | 电源边界监测，回到 Q8 形成闭环 |

**结论**：3V3_EPD 一旦关掉，所有这些电压同时丢失，屏进入未定义状态——再次启用必须重做完整 `EPD_Init()` 时序，不能"恢复"。

### 7.3 OTP 初始化与温度补偿

固定命令序列：
* `0x00 0x2F 0x2E` — OTP 启动
* `0xE9 0x01` — OTP boost
* `0x40` — 读屏内温度寄存器（占用 SDA 反向，SPI 总线要切到 RX 模式）
* `0xE6 <补偿值>` — 写温度补偿，**根据温度分 5 档**：
  * ≤5 °C → 0xE8 (-24)
  * ≤10 °C → 0xEB (-21)
  * ≤20 °C → 0xEE (-18)
  * ≤30 °C → 0xF1 (-15)
  * ≤127 °C → 0xF4 (-12)
* `0xA5` — 启动显示

不做温度补偿低温下会刷不动屏。

### 7.4 帧缓冲与分辨率

* **像素**：400 × 300，1 bpp。
* **每行字节数**：50（= (400+7)/8）。
* **整帧字节**：15 000 字节。
* **像素打包要求**：SSD2683 期望 2 bpp 输出格式（每像素拆 2 bit），所以 1 bpp → 串行打包时每字节膨胀成 2 字节，**实际 SPI 一次刷屏发送 30 KB**。
* **典型刷新时间**（实测从参考固件统计）：
  * 全屏刷新（FULL）：~2–3 s，伴随明显黑白翻转。
  * 局部刷新（PARTIAL）：~0.3–0.6 s，无明显闪烁。
  * 局部刷新累积残影，**典型每 10 次 partial 强制一次 full**。

---

## 8. 音频

### 8.1 链路

```
MIC1 (MEMS 4 脚) ──模拟──► ES8311 MIC1P ──I²S DIN(GPIO16)──► ESP32-S3
                                                                    │
ESP32-S3 ──I²S DOUT(GPIO45)──► ES8311 OUTP/OUTN ──模拟差分──► 差分 PA U5 ──► 喇叭(J2)
                                                ▲
                                       GPIO46 (PA_CTRL/PA_PIN，高=出声)
```

### 8.2 ES8311 配置约束（硬件决定的）

* **I²S Master / 16-bit / 单声道**。立体声槽只用一边，槽宽 16 bit，标准 I²S 模式。
* **MCLK 必须 = 256 × fs**（参考固件用 16 kHz × 256 = 4.096 MHz）。
* **codec_dac_voltage = 3.3 V，pa_voltage = 5 V**——这两个是 codec 内部增益曲线计算用的硬件参数，不是软件可调（与板上实际供电对齐：codec 自己吃 AVDD_3V3，外部 PA 吃 5 V 来自 boost 路径）。
* **PA_PIN 引脚就是 PA_CTRL = GPIO46**：高=PA 出声，低=静音。
* **采样率**：参考固件用 16 kHz，但 ES8311 自身支持 8/16/32/44.1/48 kHz，硬件不限。

### 8.3 防"啵"声

PA_CTRL 低 → ES8311 enable output → PA_CTRL 高，这个顺序硬件层会有过渡瞬态。参考固件用 `gpio_hold_dis/en` 包住 PA_CTRL，防止在 PM 切档 / sleep 时 PA 抽搐。

---

## 9. RTC（PCF8563）

### 9.1 寄存器（与 NXP datasheet 一致）

| 寄存器 | 说明 |
| --- | --- |
| 0x00 Control1 | 一般不动 |
| 0x01 Control2 | bit3 AF 闹钟标志 / bit2 TF 定时器标志 / bit1 AIE / bit0 TIE；**写时只动 bits[4:0]** |
| 0x02–0x08 | 秒/分/时/日/星期/月/年（BCD 码） |
| 0x09–0x0C | 闹钟分/时/日/星期，**bit7=1 表示禁用该位匹配** |
| 0x0D CLKOUT | 不用 |
| 0x0E Timer Control | bit7 enable，低 2 bit 选频率（**用 0x02 = 1 Hz**） |
| 0x0F Timer Value | 倒计时初值（秒） |

### 9.2 INT# 行为

* **GPIO5**，open-drain，**低有效**（外部不需要拉高，PCF8563 内部就是 OD），软件可打开 ESP32 内部上拉。
* 触发源（写 Control2 使能）：闹钟匹配 (AIE+AF) 或定时器倒计时到 0 (TIE+TF)。
* 在 ESP 这边读到下降沿后，必须回写 Control2 把对应 flag 清掉，否则 INT# 一直保持低。

### 9.3 备份供电

D8/D9 二极管 OR 把 3V3 和 VBAT 都接到 PWR_RTC（PCF8563 VDD）。系统关机时 PCF8563 直接吃电池，仍走时（典型 0.25 µA，对锂电消耗可忽略）。

**含义**：你重新上电后 PCF8563 里的时间不需要重新设，可以直接读出来用。

---

## 10. NFC（GT23SC6699）

### 10.1 内存布局（Type 2 Tag 兼容）

```
Block 0x00         UID block（7 字节 UID + BCC 校验）
Block 0x01..0x37   用户数据区，55 个 block × 16 B = 880 B
                   （其中 0x04..0x37 在参考固件里被当"命令交互区"用，但硬件没限制）
```

每次 I²C 读写最小单位 = 1 个 block = 16 字节。

### 10.2 FD 引脚（场检测）

* **GPIO7**，**低有效**（有读卡器近场时拉低）。
* 任意边沿可中断；上拉打开。
* 实际使用要 ~20 ms 软件去抖（电磁场会跳变）。

### 10.3 I²C 时序最小值（GT23SC6699 datasheet 提取）

| 操作 | 最小延时 |
| --- | --- |
| 上电稳定 | 1 ms |
| 断电再上电 | 5 ms |
| 单次 transfer 之间 | 5 ms |
| Block 读完到下次访问 | 10 ms |

不满足这些延时会随机回 NACK 或读到 0xFF。

### 10.4 电源

GPIO21 (NFC_PWR) 拉高才能用；不用时可拉低省电（但 FD 中断也失效）。

---

## 11. 按键

板上 4 颗按键：

| 键 | 原理图 | 接到 | 极性 |
| --- | --- | --- | --- |
| 确认（ENTER） | SW4 | GPIO0（同 BOOT 键） | 低有效；上电瞬间按住会进 ROM 下载模式 |
| 上键（PG_UP） | SW2 | GPIO39 | 低有效 |
| 下键（PG_DN）+ 上电检测 | SW1 | GPIO18 | 低有效；与软锁存电源开关物理共线 |
| **硬复位** | SW3 | EN# | 直接把 ESP32 模组 EN# 拉到 GND，纯硬件复位，固件管不到 |

按键都没装外部上拉（依赖 ESP32 内部上拉 + ROM 默认上拉行为），用之前要 `gpio_pullup_en`。

---

## 12. LED

* **单颗绿色 LED**（LED1），串 R35。
* 控制脚：**GPIO3 (LED_G)**，**低有效**（GPIO3 = 0 → LED 亮，GPIO3 = 1 → LED 灭）。
* 板上没装其他 LED；想要状态指示只能复用这一颗。

---

## 13. 接口

| 接口 | 引脚 | 说明 |
| --- | --- | --- |
| Type-C (USB1) | 24 脚标准 USB Type-C | VBUS → 充电 IC VIN；DP/DN → ESP32 GPIO19/20（USB CDC/JTAG） |
| J1 电池座 | 2 脚 | VBAT / GND，单节锂电池 |
| J2 喇叭座 | 4 脚 | PA U5 差分输出 AOUT_P / AOUT_N |
| J3 调试座 | 6 脚 | 3V3 / GND / TXD0 (GPIO43) / RXD0 (GPIO44) / GPIO40 / GPIO41 + 抓 STDBY_H / CHRG_L 用 |

USB Type-C 直接走 ESP32-S3 内置 USB CDC/JTAG，不需要外部 USB-串口芯片。烧录、log、调试都可以走 USB；UART0 (GPIO43/44) 留作冗余。

---

## 14. 休眠 / 唤醒能力（硬件可选项）

* **可作为深睡唤醒源的 GPIO**（ESP32-S3 RTC GPIO 范围内，全部都符合）：
  * GPIO0（确认键）、GPIO18（下键）、GPIO39（上键）
  * GPIO5（RTC_INT，PCF8563 闹钟/定时器）
  * GPIO7（NFC_FD，贴卡唤醒）
  * GPIO2（CHRG_L，插充电唤醒）/ GPIO1（STDBY_H，充满唤醒）
* **PCF8563 闹钟**是最省电的定时唤醒方案（远比 ESP32 内部 RTC 准，且 RTC 走时不依赖系统电源）。
* **关机**和**深睡**的差异：
  * 深睡 = 拉低各 rail（保留 PWR_ON=高），ESP32 进 deep sleep。RAM 不保留，唤醒后从 app_main 重启。功耗 ~10 µA + 漏电。
  * 关机 = 拉低 GPIO17，整机断电（PCF8563 还在）。再次上电只能靠按下键重新触发软锁存。
* **Octal PSRAM + sleep 的硬件级 workaround**（必须开，否则休眠漏几 mA）：
  * `ESP_SLEEP_FLASH_LEAKAGE_WORKAROUND`
  * `ESP_SLEEP_PSRAM_LEAKAGE_WORKAROUND`
  * `ESP_SLEEP_MSPI_NEED_ALL_IO_PU`
  * `ESP_SLEEP_GPIO_RESET_WORKAROUND`
  这些不是软件偏好，是 ESP32-S3 + Octal PSRAM 这种封装的硬件特性，不开就漏电。

---

## 15. 常见硬件操作清单

> 这一节是"知道硬件长这样后，要做某件事必须做的步骤"。函数名留给你新固件自己起。

### 读电池电量
1. 配置 ADC1_CH3 (GPIO4)，12-bit，衰减 12 dB，curve_fitting 校准。
2. 连读 N 次（参考固件 10 次）取均值。
3. ×2 还原到电池真实电压（mV）。
4. 套二阶多项式（§6.2）→ clamp(0, 100)。

### 读充电状态
1. GPIO1 (STDBY_H) 输入，GPIO2 (CHRG_L) 输入，**不要打开内部上下拉**（充电 IC 是开漏 / 推挽自驱）。
2. 周期采样（≥ 5 Hz），用 §6.3 的去抖窗口判别四种状态。

### 关机
1. （可选）保存任何需要持久化的 NVS。
2. 拉低 GPIO17，立即 `gpio_hold_en`。
3. 系统断电，函数不会返回。

### 进 deep sleep
1. 关掉所有可关 rail（EPD_PWR_EN、NFC_PWR、PA_PWR_EN）。注意 PA_PWR_EN 关了之后任何 I²C 都会失败。
2. 把唤醒 GPIO 配成 RTC GPIO（`rtc_gpio_init` + `rtc_gpio_pullup_en/pulldown_en`）。
3. 配置 EXT1 唤醒源（多 GPIO 任一边沿）。
4. （可选）`esp_sleep_enable_timer_wakeup` 或让 PCF8563 闹钟代劳。
5. `esp_deep_sleep_start()`。

### 用 PCF8563 做定时唤醒
1. 通过 I²C 写闹钟寄存器（0x09–0x0C）或定时器（0x0E + 0x0F）。
2. 写 Control2 (0x01) 使能 AIE 或 TIE。
3. 把 GPIO5 配成 RTC GPIO，下降沿唤醒。
4. 唤醒后回写 Control2 清掉 AF/TF flag，否则 INT# 一直保持低。

### 刷新墨水屏（局部）
1. 确保 GPIO6 (EPD_PWR_EN) = 1。
2. 等 GPIO8 (BUSY) = 高（空闲）。
3. SPI 发送 SSD2683 init 命令序列（§7.3）。
4. 设置局部窗口（命令略，参考 SSD2683 datasheet）。
5. 一次 SPI transaction 推完所有数据（实际 30 KB，因 1bpp → 2bpp 膨胀）。
6. 发 0xA5 启动，再 poll BUSY 到拉高（空闲）。
7. **每累计 10 次 partial 至少做一次 full 刷新**，否则残影累积到肉眼可见。

### 在播放/录音前/后控制 PA
1. 出声前：先 enable codec output，再拉高 GPIO46 (PA_CTRL)。
2. 静音时：先拉低 GPIO46，再 disable codec output。
3. 顺序错了会出"啵"声。

### NFC 读卡（响应外部读卡器）
1. 拉高 GPIO21 (NFC_PWR)，等 ≥ 5 ms。
2. 监听 GPIO7 (NFC_FD) 下降沿（注意 20 ms 去抖）。
3. 提前把要被读的 NDEF 数据写到 user 区（block 0x01 起）。
4. NFC 芯片自动响应外部读卡器，软件无需介入读卡过程。

### 任何 I²C 操作的前置（重要）
1. **拉高 GPIO42 (PA_PWR_EN) + `gpio_hold_en`**——否则 I²C 没上拉，三个外设全死。
2. （多核/多任务）取全局 I²C 互斥锁。
3. 做 I²C 事务。
4. 释放互斥锁。
