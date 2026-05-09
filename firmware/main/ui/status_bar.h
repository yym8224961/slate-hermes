#pragma once

// 顶部 28px 小状态栏：左 WiFi 图标 / 中 caption / 右电量图标。
// 不持有刷屏策略，只 set_text；调用方（FrameScene）决定何时调
// epd->RequestUrgentPartialRefresh()。

#include <lvgl.h>

#include <string>

class StatusBar {
   public:
    explicit StatusBar(lv_obj_t* parent);

    // 返回 true 表示有任何字段实际变化（调用方据此决定是否刷屏）。
    bool SetWifi(bool connected, int rssi);
    bool SetBattery(int pct, bool charging);
    bool SetCaption(const std::string& text);

    void Show();
    void Hide();

   private:
    lv_obj_t* root_           = nullptr;
    lv_obj_t* wifi_label_     = nullptr;
    lv_obj_t* battery_label_  = nullptr;
    lv_obj_t* battery_pct_lbl_ = nullptr;  // 电池图标左侧的百分比文字
    lv_obj_t* caption_label_  = nullptr;

    const char* shown_wifi_    = nullptr;
    const char* shown_battery_ = nullptr;
    int         shown_pct_     = -2;  // -1 表示无电池/未知,-2 表示从未 set 过(强制首次 redraw)
    std::string shown_caption_;
};
