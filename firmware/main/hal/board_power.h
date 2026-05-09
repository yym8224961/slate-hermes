#pragma once

// 系统级电源管理。只管「系统的」两条 rail：
//   - VBAT 软锁存（GPIO17 拉低=关机的唯一手段）
//   - AVDD_3V3 / Audio rail（GPIO42，关掉=I²C 死、ES8311/PA/MIC 失能）
// EPD_PWR(GPIO6) 由 EpdSsd1683 自管；PA_CTRL(GPIO46) 由 esp_codec_dev 库通过
// es8311_codec_cfg_t::pa_pin 自管。
//
// LED（GPIO3）：阶段 1 起不再走充电状态闪烁（屏保取消 → 改由状态栏指示）。
// 这里只在 InitLed() 把 GPIO3 配成 OUTPUT 并熄灭，之后不再驱动。

class BoardPowerBsp {
   public:
    BoardPowerBsp(int audioPowerPin, int vbatPowerPin);
    ~BoardPowerBsp() = default;

    // 一次性把 LED 配成 OUTPUT 并熄灭。可在 Init 序列任意点调，幂等。
    void InitLed();

    void PowerAudioOn();
    void PowerAudioOff();
    void VbatPowerOn();
    void VbatPowerOff();

   private:
    const int audioPowerPin_;
    const int vbatPowerPin_;
};
