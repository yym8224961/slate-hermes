#pragma once

#include <algorithm>

#include <lvgl.h>

#include "ui/theme.h"

namespace ui {

struct ScrollbarTrack {
    int x        = LV_HOR_RES - theme::kScrollbarThumbW - theme::kScrollbarThumbRightPad;
    int y        = 0;
    int height   = 0;
    int min_size = theme::kScrollbarThumbMinH;
};

inline void StyleScrollbarThumb(lv_obj_t* thumb) {
    lv_obj_set_style_bg_color(thumb, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(thumb, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(thumb, 0, 0);
    lv_obj_set_style_radius(thumb, 0, 0);
    lv_obj_set_style_pad_all(thumb, 0, 0);
    lv_obj_clear_flag(thumb, LV_OBJ_FLAG_SCROLLABLE);
}

inline void PositionPagedScrollbar(lv_obj_t* thumb, const ScrollbarTrack& track, int visible_items, int total_items,
                                   int first_visible_item) {
    if (!thumb || total_items <= visible_items || visible_items <= 0 || track.height <= 0) {
        if (thumb)
            lv_obj_add_flag(thumb, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    lv_obj_clear_flag(thumb, LV_OBJ_FLAG_HIDDEN);
    const int thumb_h     = std::clamp((track.height * visible_items) / total_items, track.min_size, track.height);
    const int max_top     = total_items - visible_items;
    const int thumb_y_max = track.height - thumb_h;
    const int thumb_y     = (max_top > 0) ? (thumb_y_max * first_visible_item / max_top) : 0;
    lv_obj_set_size(thumb, theme::kScrollbarThumbW, thumb_h);
    lv_obj_set_pos(thumb, track.x, track.y + thumb_y);
}

inline void PositionScrollableThumb(lv_obj_t* thumb, const ScrollbarTrack& track, int visible_h, int max_scroll,
                                    int scroll_y) {
    if (!thumb || max_scroll <= 0 || visible_h <= 0 || track.height <= 0) {
        if (thumb)
            lv_obj_add_flag(thumb, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    lv_obj_clear_flag(thumb, LV_OBJ_FLAG_HIDDEN);
    const int content_h   = visible_h + max_scroll;
    const int thumb_h     = std::clamp((track.height * visible_h) / content_h, track.min_size, track.height);
    const int thumb_y_max = track.height - thumb_h;
    const int thumb_y     = (thumb_y_max * scroll_y) / max_scroll;
    lv_obj_set_size(thumb, theme::kScrollbarThumbW, thumb_h);
    lv_obj_set_pos(thumb, track.x, track.y + thumb_y);
}

}  // namespace ui
