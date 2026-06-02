#include "ui/frame_view.h"

#include <esp_log.h>

#include "drivers/display/epd_ssd1683.h"
#include "ui/theme.h"

namespace {
constexpr char kTag[]      = "frame_view";
constexpr int  kStatusBarH = theme::kStatusBarHeight;
constexpr int  kImgH       = FrameView::kHeight - kStatusBarH;
constexpr int  kBpr        = FrameView::kWidth >> 3;
constexpr int  kImgBytes   = kImgH * kBpr;
}  // namespace

FrameView::FrameView(lv_obj_t* parent) {
    container_ = lv_obj_create(parent);
    lv_obj_set_size(container_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(container_, 0, 0);
    lv_obj_set_style_bg_color(container_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(container_, 0, 0);
    lv_obj_set_style_border_width(container_, 0, 0);
    lv_obj_clear_flag(container_, LV_OBJ_FLAG_SCROLLABLE);
}

void FrameView::SetFrame(EpdSsd1683* epd, const std::vector<uint8_t>& raw) {
    if (!epd)
        return;
    if (raw.size() != kRawBytes) {
        ESP_LOGW(kTag, "raw size mismatch bytes=%u expected=%d", static_cast<unsigned>(raw.size()), kRawBytes);
        return;
    }
    epd->WriteRaw1bpp(0, kStatusBarH, kWidth, kImgH, raw.data() + kStatusBarH * kBpr, kImgBytes);
}

void FrameView::Show() {
    if (container_)
        lv_obj_clear_flag(container_, LV_OBJ_FLAG_HIDDEN);
}

void FrameView::Hide() {
    if (container_)
        lv_obj_add_flag(container_, LV_OBJ_FLAG_HIDDEN);
}
