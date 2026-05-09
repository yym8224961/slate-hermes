#include "frame_view.h"

#include <cstring>
#include <esp_log.h>

#include "theme.h"

namespace {
constexpr char kTag[] = "frame_view";

// LVGL 9 LV_COLOR_FORMAT_I1 调色板：8 字节，2 项，每项 BGRA32
//   palette[0] = 黑（bit=0）
//   palette[1] = 白（bit=1）
constexpr uint8_t kPaletteBlackWhite[8] = {
    0x00, 0x00, 0x00, 0xFF,  // black
    0xFF, 0xFF, 0xFF, 0xFF,  // white
};
constexpr int kPaletteSize = sizeof(kPaletteBlackWhite);
constexpr int kBufBytes    = FrameView::kRawBytes + kPaletteSize;
}  // namespace

FrameView::FrameView(lv_obj_t* parent) {
    buf_.resize(kBufBytes);
    std::memcpy(buf_.data(), kPaletteBlackWhite, kPaletteSize);

    dsc_.header.cf     = LV_COLOR_FORMAT_I1;
    dsc_.header.w      = kWidth;
    dsc_.header.h      = kHeight;
    dsc_.header.stride = (kWidth + 7) >> 3;
    dsc_.data_size     = kBufBytes;
    dsc_.data          = buf_.data();

    container_ = lv_obj_create(parent);
    lv_obj_set_size(container_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(container_, 0, 0);
    lv_obj_set_style_bg_color(container_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(container_, 0, 0);
    lv_obj_set_style_border_width(container_, 0, 0);
    lv_obj_clear_flag(container_, LV_OBJ_FLAG_SCROLLABLE);

    // image 全屏居中。状态栏白底浮在最上 28px 会盖住 image 顶部一小块,
    // 12 张工程车图主体在中间偏下,顶部通常是天空/留白,可接受。
    image_ = lv_image_create(container_);
    lv_obj_align(image_, LV_ALIGN_CENTER, 0, 0);
}

bool FrameView::SetFrame(const std::vector<uint8_t>& raw) {
    if (raw.size() != kRawBytes) {
        ESP_LOGW(kTag, "raw size %u != %d", static_cast<unsigned>(raw.size()), kRawBytes);
        return false;
    }
    std::memcpy(buf_.data() + kPaletteSize, raw.data(), raw.size());
    if (image_) {
        lv_image_set_src(image_, nullptr);  // 强制 invalidate
        lv_image_set_src(image_, &dsc_);
        lv_obj_align(image_, LV_ALIGN_CENTER, 0, 0);
    }
    if (container_) {
        lv_obj_invalidate(container_);
    }
    return true;
}

void FrameView::Show() {
    if (container_) lv_obj_clear_flag(container_, LV_OBJ_FLAG_HIDDEN);
}

void FrameView::Hide() {
    if (container_) lv_obj_add_flag(container_, LV_OBJ_FLAG_HIDDEN);
}
