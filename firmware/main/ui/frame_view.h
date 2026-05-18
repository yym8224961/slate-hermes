#pragma once

#include <lvgl.h>

#include <vector>

class EpdSsd1683;

class FrameView {
   public:
    static constexpr int kWidth    = 400;
    static constexpr int kHeight   = 300;
    static constexpr int kRawBytes = kWidth * kHeight / 8;

    explicit FrameView(lv_obj_t* parent);

    void SetFrame(EpdSsd1683* epd, const std::vector<uint8_t>& raw);
    void Show();
    void Hide();

   private:
    lv_obj_t* container_ = nullptr;
};
