#pragma once

// EPD 友好的列表 widget:每项一个 lv_label,光标项行首换成 "▶ ",
// 其他行 "  "。这样 partial refresh dirty 区域只是两个箭头位置,
// 不需要整个行反白(反白会让 partial refresh 大面积变化触发 full)。

#include <functional>
#include <string>
#include <vector>

#include <lvgl.h>

class MenuList {
   public:
    struct Item {
        std::string           title;
        std::function<void()> on_enter;  // ENTER 短按触发
    };

    MenuList(lv_obj_t* parent, std::vector<Item> items, int initial_cursor = 0);

    void OnUp();     // 光标上移(wrap)
    void OnDown();   // 光标下移(wrap)
    void OnEnter();  // 触发当前项

    int Cursor() const {
        return cursor_;
    }
    lv_obj_t* root() {
        return root_;
    }

   private:
    void Redraw();

    std::vector<Item>      items_;
    int                    cursor_ = 0;
    lv_obj_t*              root_   = nullptr;
    std::vector<lv_obj_t*> labels_;
    std::vector<lv_obj_t*> cursor_bars_;
};
