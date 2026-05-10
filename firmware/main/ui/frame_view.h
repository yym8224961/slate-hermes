#pragma once

// 1bpp 帧渲染 widget：400×300 黑白图，直接写入 EPD framebuffer。
// 不负责刷屏（由 Scene 决定 partial/full）。

#include <cstdint>
#include <vector>

#include <lvgl.h>

class EpdSsd1683;

class FrameView {
   public:
    static constexpr int kWidth    = 400;
    static constexpr int kHeight   = 300;
    static constexpr int kRawBytes = (kWidth * kHeight) / 8;  // 15000

    explicit FrameView(lv_obj_t* parent);

    // raw 必须是 kRawBytes 字节（1bpp，每行 50 字节，server 渲染对齐）。
    // 调用前需已完成 lv_refr_now，以免 LVGL 渲染覆盖写入的图像数据。
    void SetFrame(EpdSsd1683* epd, const std::vector<uint8_t>& raw);

    void Show();
    void Hide();

   private:
    lv_obj_t* container_ = nullptr;
};
