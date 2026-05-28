#pragma once

#include <driver/gpio.h>

// 板级 pinout / 常量。命名风格统一 UPPER_SNAKE,与 ESP-IDF Kconfig 风格一致。
// 本文件不引入运行时逻辑,只供其他 .cc 直接 #include "config.h"。

// ── Audio (ES8311) ─────────────────────────────────────────────
#define AUDIO_OUTPUT_SAMPLE_RATE   16000
#define AUDIO_PCM_BYTES_PER_SAMPLE 2
#define AUDIO_MAX_DURATION_SEC     60
#define AUDIO_MAX_PCM_BYTES        (AUDIO_OUTPUT_SAMPLE_RATE * AUDIO_PCM_BYTES_PER_SAMPLE * AUDIO_MAX_DURATION_SEC)

#define AUDIO_I2S_GPIO_MCLK GPIO_NUM_14
#define AUDIO_I2S_GPIO_WS   GPIO_NUM_38
#define AUDIO_I2S_GPIO_BCLK GPIO_NUM_15
#define AUDIO_I2S_GPIO_DIN  GPIO_NUM_16
#define AUDIO_I2S_GPIO_DOUT GPIO_NUM_45

#define AUDIO_CODEC_PA_PIN      GPIO_NUM_46
#define AUDIO_CODEC_I2C_SDA_PIN GPIO_NUM_47
#define AUDIO_CODEC_I2C_SCL_PIN GPIO_NUM_48
#define AUDIO_CODEC_ES8311_ADDR ES8311_CODEC_DEFAULT_ADDR

// ── Buttons ────────────────────────────────────────────────────
#define BOOT_BUTTON_GPIO GPIO_NUM_0
#define UP_BUTTON_GPIO   GPIO_NUM_39
#define DOWN_BUTTON_GPIO GPIO_NUM_18  // 与 POWER_KEY_GPIO 复用:开机时电源键 = 下键

// ── Charge IC ──────────────────────────────────────────────────
#define CHARGE_DETECT_GPIO           GPIO_NUM_2
#define CHARGE_FULL_GPIO             GPIO_NUM_1
#define CHARGE_DETECT_CHARGING_LEVEL 0  // 0=低有效充电,1=高有效

// ── EPD (SSD1683) ──────────────────────────────────────────────
#define EPD_SPI_NUM SPI3_HOST

#define EPD_DC_PIN   GPIO_NUM_10
#define EPD_CS_PIN   GPIO_NUM_11
#define EPD_SCK_PIN  GPIO_NUM_12
#define EPD_MOSI_PIN GPIO_NUM_13
#define EPD_RST_PIN  GPIO_NUM_9
#define EPD_BUSY_PIN GPIO_NUM_8

// ── 系统电源 ──────────────────────────────────────────────────
#define EPD_PWR_PIN           GPIO_NUM_6   // EPD 电源,EpdSsd1683 自管
#define AUDIO_PWR_PIN         GPIO_NUM_42  // AVDD_3V3 rail (I²C 上拉也在这条 rail)
#define AUDIO_PWR_FORCE_LEVEL 1
#define VBAT_PWR_PIN          GPIO_NUM_17       // 系统软锁存,拉低 = 关机
#define POWER_KEY_GPIO        DOWN_BUTTON_GPIO  // SW1=下键开机,松开时 board_power 等其松开
