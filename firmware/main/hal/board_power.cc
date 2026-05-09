#include "board_power.h"

#include <driver/gpio.h>
#include <esp_log.h>

#include "gpio_util.h"

namespace {
constexpr char       kTag[]   = "BoardPower";
constexpr gpio_num_t kLedPin  = GPIO_NUM_3;  // 板上唯一一颗绿色 LED，低有效
}  // namespace

BoardPowerBsp::BoardPowerBsp(int audioPowerPin, int vbatPowerPin)
    : audioPowerPin_(audioPowerPin), vbatPowerPin_(vbatPowerPin) {
    // VBAT_PWR(GPIO17): 系统软锁存，拉高=自锁，拉低=断电（关机唯一手段）
    // Audio_PWR(GPIO42): AVDD_3V3 rail，关掉 = I²C 死（R45/R46 上拉在这条 rail）
    gpio_config_t cfg = {};
    cfg.intr_type     = GPIO_INTR_DISABLE;
    cfg.mode          = GPIO_MODE_OUTPUT;
    cfg.pin_bit_mask  = (1ULL << audioPowerPin_) | (1ULL << vbatPowerPin_);
    cfg.pull_up_en    = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&cfg));
}

void BoardPowerBsp::InitLed() {
    // GPIO3 是 strapping pin（高=不打 ROM log）。板上 R35 已经把它上拉到 3V3，
    // 所以复位瞬间 LED 灭、ROM 不打 log。这里再配置成 OUTPUT 并写高（继续灭）。
    gpio_config_t cfg = {};
    cfg.intr_type     = GPIO_INTR_DISABLE;
    cfg.mode          = GPIO_MODE_OUTPUT;
    cfg.pin_bit_mask  = 1ULL << kLedPin;
    cfg.pull_up_en    = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&cfg));
    GpioWriteHold(kLedPin, 1);
    ESP_LOGI(kTag, "LED off (status bar 接管充电指示)");
}

void BoardPowerBsp::PowerAudioOn()  { GpioWriteHold(audioPowerPin_, 1); }
void BoardPowerBsp::PowerAudioOff() { GpioWriteHold(audioPowerPin_, 0); }
void BoardPowerBsp::VbatPowerOn()   { GpioWriteHold(vbatPowerPin_, 1); }
void BoardPowerBsp::VbatPowerOff()  { GpioWriteHold(vbatPowerPin_, 0); }
