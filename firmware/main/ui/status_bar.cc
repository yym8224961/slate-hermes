#include "status_bar.h"

#include <cstdio>

#include "theme.h"

namespace {

const char* WifiIcon(bool connected, int rssi) {
    if (!connected) return FONT_AWESOME_WIFI_SLASH;
    if (rssi >= -65) return FONT_AWESOME_WIFI;
    if (rssi >= -75) return FONT_AWESOME_WIFI_FAIR;
    return FONT_AWESOME_WIFI_WEAK;
}

const char* BatteryIcon(int pct, bool charging, bool full) {
    if (full)     return FONT_AWESOME_BATTERY_FULL;
    if (charging) return FONT_AWESOME_BATTERY_BOLT;
    if (pct < 0)  return FONT_AWESOME_BATTERY_EMPTY;
    if (pct >= 80) return FONT_AWESOME_BATTERY_FULL;
    if (pct >= 60) return FONT_AWESOME_BATTERY_THREE_QUARTERS;
    if (pct >= 40) return FONT_AWESOME_BATTERY_HALF;
    if (pct >= 20) return FONT_AWESOME_BATTERY_QUARTER;
    return FONT_AWESOME_BATTERY_EMPTY;
}

void ApplyIconStyle(lv_obj_t* lbl) {
    lv_obj_set_style_text_font(lbl, &font_awesome_14_1, 0);
    lv_obj_set_style_text_color(lbl, lv_color_black(), 0);
    lv_label_set_text(lbl, "");
}

}  // namespace

StatusBar::StatusBar(lv_obj_t* parent) {
    root_ = lv_obj_create(parent);
    lv_obj_set_size(root_, LV_HOR_RES, theme::kStatusBarHeight);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 1, 0);
    lv_obj_set_style_border_color(root_, lv_color_black(), 0);
    lv_obj_set_style_border_side(root_, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    wifi_label_ = lv_label_create(root_);
    ApplyIconStyle(wifi_label_);
    lv_obj_align(wifi_label_, LV_ALIGN_LEFT_MID, 8, 0);

    // 右边布局: ... [pct text] [battery icon] |
    //                                          -8px end
    // 图标贴右边,百分比在它左边。都用原生 14px 1bpp 字模(font_awesome_14_1),
    // 不做任何缩放 — 1bpp + 非整数 transform_scale 必出锯齿,18px 子集 + fallback
    // 14px 又造成充电状态字号跳变,不如统一 14px 视觉一致。
    battery_label_ = lv_label_create(root_);
    ApplyIconStyle(battery_label_);
    lv_obj_align(battery_label_, LV_ALIGN_RIGHT_MID, -8, 0);

    // 百分比偏左 — 14px 图标 advance ~14px + 4px 间距 = 18,起算偏移 -26。
    // 数字用 FusionPixel 12px 像素体(ASCII 子集),比 16px 思源更紧凑工整,
    // 1bpp EPD 下小字号像素感强、笔画整齐。
    battery_pct_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_font(battery_pct_lbl_, &FusionPixel_12, 0);
    lv_obj_set_style_text_color(battery_pct_lbl_, lv_color_black(), 0);
    lv_label_set_text(battery_pct_lbl_, "");
    lv_obj_align(battery_pct_lbl_, LV_ALIGN_RIGHT_MID, -26, 0);

    // 中央 caption：16px SourceHanSansSC Regular 1bpp。和 BootSplash 同字体,
    // 整固件统一中文风格,EPD 1bpp 渲染最干净（无抗锯齿伪边）。
    caption_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(caption_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(caption_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(caption_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(caption_label_, "");
    lv_obj_align(caption_label_, LV_ALIGN_CENTER, 0, 0);
}

bool StatusBar::SetWifi(bool connected, int rssi) {
    const char* icon = WifiIcon(connected, rssi);
    if (icon == shown_wifi_) return false;
    shown_wifi_ = icon;
    lv_label_set_text(wifi_label_, icon);
    return true;
}

bool StatusBar::SetBattery(int pct, bool charging, bool full) {
    bool        changed = false;
    const char* icon    = BatteryIcon(pct, charging, full);
    if (icon != shown_battery_) {
        shown_battery_ = icon;
        lv_label_set_text(battery_label_, icon);
        changed = true;
    }

    // 数字策略:
    //   full       → "100%"(STDBY 拉高,物理可信)
    //   charging   → ""(ADC 端电压被充电 IC 拉到 4.0-4.2V,SoC 不可信,只剩 BOLT 图标)
    //   pct >= 0   → "%d%%"
    //   pct < 0    → "--"(无电池 / 未读到)
    char buf[16] = "";
    if (full) {
        std::snprintf(buf, sizeof(buf), "100%%");
    } else if (charging) {
        // 留空,只剩图标
    } else if (pct < 0) {
        std::snprintf(buf, sizeof(buf), "--");
    } else {
        const int clamped = pct > 100 ? 100 : pct;
        std::snprintf(buf, sizeof(buf), "%d%%", clamped);
    }
    if (buf != shown_pct_text_) {
        shown_pct_text_ = buf;
        lv_label_set_text(battery_pct_lbl_, buf);
        lv_obj_align(battery_pct_lbl_, LV_ALIGN_RIGHT_MID, -26, 0);
        changed = true;
    }
    return changed;
}

bool StatusBar::SetCaption(const std::string& text) {
    if (text == shown_caption_) return false;
    shown_caption_ = text;
    lv_label_set_text(caption_label_, text.c_str());
    lv_obj_align(caption_label_, LV_ALIGN_CENTER, 0, 0);
    return true;
}

void StatusBar::Show() {
    if (root_) lv_obj_clear_flag(root_, LV_OBJ_FLAG_HIDDEN);
}

void StatusBar::Hide() {
    if (root_) lv_obj_add_flag(root_, LV_OBJ_FLAG_HIDDEN);
}
