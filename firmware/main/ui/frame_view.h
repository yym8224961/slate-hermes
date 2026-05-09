#pragma once

// 1bpp 帧渲染 widget：400×300 黑白图，全屏铺满。caption 由 StatusBar 处理。
// 不负责刷屏（由 Scene 决定 partial/full）。

#include <cstdint>
#include <vector>

#include <lvgl.h>

class FrameView {
   public:
    static constexpr int kWidth     = 400;
    static constexpr int kHeight    = 300;
    static constexpr int kRawBytes  = (kWidth * kHeight) / 8;  // 15000

    explicit FrameView(lv_obj_t* parent);

    // raw 必须是 kRawBytes 字节（1bpp，每行 50 字节，server 渲染对齐）。
    bool SetFrame(const std::vector<uint8_t>& raw);

    lv_obj_t* root() { return container_; }
    void Show();
    void Hide();

   private:
    lv_obj_t*           container_ = nullptr;
    lv_obj_t*           image_     = nullptr;
    lv_image_dsc_t      dsc_       = {};
    std::vector<uint8_t> buf_;  // 8B palette + 15000B raw = 15008B
};
