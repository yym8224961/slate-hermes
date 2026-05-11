#include "menu_list.h"

#include "theme.h"

namespace {
// list root 高度 = 屏 300 - status bar 24 = 276。对称 pad 12 + 6 行 × 42 = 276。
// 选 6 行 + 42 行高:行间不空,设置页 6 项可完整放进一屏。
// thumb track 区 [pad_top, root_h - pad_bot] 自然对称,顶/底间距相等。
constexpr int kRowHeight  = 42;
constexpr int kListPadTop = 12;
constexpr int kListPadBot = 12;  // thumb track 起止靠它对称撑到底
constexpr int kRowPadL    = 32;
constexpr int kRowPadR    = 24;
constexpr int kCursorBarW = 4;
constexpr int kCursorBarH = 22;
// 右侧 thumb 几何定义在 theme.h,与 DeviceInfoPage 共用。
}  // namespace

MenuList::MenuList(lv_obj_t* parent, std::vector<Item> items, int initial_cursor)
    : items_(std::move(items)) {
    if (!items_.empty()) {
        cursor_ = initial_cursor;
        if (cursor_ < 0) cursor_ = 0;
        if (cursor_ >= static_cast<int>(items_.size())) cursor_ = static_cast<int>(items_.size()) - 1;
    }
    root_ = lv_obj_create(parent);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(root_, 0, theme::kStatusBarHeight);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    rows_.reserve(items_.size());
    cursor_bars_.reserve(items_.size());

    for (size_t i = 0; i < items_.size(); ++i) {
        // 行容器:透明背景,只是为了对齐子元素的逻辑组。y 由 Redraw 按 viewport 设置。
        auto* row = lv_obj_create(root_);
        lv_obj_set_size(row, LV_HOR_RES, kRowHeight);
        lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_all(row, 0, 0);
        lv_obj_set_style_border_width(row, 0, 0);
        lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);
        rows_.push_back(row);

        // 光标 bar:左侧 4x22 黑实心矩形,选中时可见。partial refresh 仅刷这块,
        // 切换光标 dirty 区域很小,EPD 翻动顺滑。
        auto* bar = lv_obj_create(row);
        lv_obj_set_size(bar, kCursorBarW, kCursorBarH);
        lv_obj_set_pos(bar, kRowPadL / 2 - kCursorBarW / 2, (kRowHeight - kCursorBarH) / 2);
        lv_obj_set_style_bg_color(bar, lv_color_black(), 0);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(bar, 0, 0);
        lv_obj_set_style_radius(bar, 0, 0);
        cursor_bars_.push_back(bar);

        // 主文字
        auto* lbl = lv_label_create(row);
        lv_obj_set_style_text_font(lbl, &SourceHanSansSC_Regular_slim, 0);
        lv_obj_set_style_text_color(lbl, lv_color_black(), 0);
        lv_label_set_text(lbl, items_[i].title.c_str());
        lv_obj_align(lbl, LV_ALIGN_LEFT_MID, kRowPadL, 0);

        // 右侧 chevron(用 ASCII '>' 配合现有 16px 字体即可,不必引大字号)
        auto* chev = lv_label_create(row);
        lv_obj_set_style_text_font(chev, &SourceHanSansSC_Regular_slim, 0);
        lv_obj_set_style_text_color(chev, lv_color_black(), 0);
        lv_label_set_text(chev, ">");
        lv_obj_align(chev, LV_ALIGN_RIGHT_MID, -kRowPadR, 0);
    }

    // 右侧 thumb scrollbar,items <= kVisibleRows 时不创建。
    if (static_cast<int>(items_.size()) > kVisibleRows) {
        thumb_ = lv_obj_create(root_);
        lv_obj_set_style_bg_color(thumb_, lv_color_black(), 0);
        lv_obj_set_style_bg_opa(thumb_, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(thumb_, 0, 0);
        lv_obj_set_style_radius(thumb_, 0, 0);
        lv_obj_set_style_pad_all(thumb_, 0, 0);
        lv_obj_clear_flag(thumb_, LV_OBJ_FLAG_SCROLLABLE);
    }

    EnsureCursorVisible();
    Redraw();
}

bool MenuList::OnUp() {
    if (items_.empty()) return false;
    cursor_ = (cursor_ - 1 + static_cast<int>(items_.size())) % static_cast<int>(items_.size());
    const bool scrolled = EnsureCursorVisible();
    Redraw();
    return scrolled;
}

bool MenuList::OnDown() {
    if (items_.empty()) return false;
    cursor_ = (cursor_ + 1) % static_cast<int>(items_.size());
    const bool scrolled = EnsureCursorVisible();
    Redraw();
    return scrolled;
}

void MenuList::OnEnter() {
    if (cursor_ < 0 || cursor_ >= static_cast<int>(items_.size())) return;
    auto& cb = items_[cursor_].on_enter;
    if (cb) cb();
}

bool MenuList::EnsureCursorVisible() {
    const int total = static_cast<int>(items_.size());
    if (total <= kVisibleRows) {
        // 不滚动场景:viewport 永远 0。
        if (viewport_top_ == 0) return false;
        viewport_top_ = 0;
        return true;
    }
    const int prev = viewport_top_;
    if (cursor_ < viewport_top_) {
        viewport_top_ = cursor_;
    } else if (cursor_ >= viewport_top_ + kVisibleRows) {
        viewport_top_ = cursor_ - kVisibleRows + 1;
    }
    // clamp:wrap-around 时 cursor 跳到极端可能算超界,这里夹紧。
    const int max_top = total - kVisibleRows;
    if (viewport_top_ < 0) viewport_top_ = 0;
    if (viewport_top_ > max_top) viewport_top_ = max_top;
    return viewport_top_ != prev;
}

void MenuList::Redraw() {
    const int total = static_cast<int>(items_.size());
    for (int i = 0; i < total; ++i) {
        const int  rel     = i - viewport_top_;
        const bool visible = rel >= 0 && rel < kVisibleRows;
        if (visible) {
            lv_obj_clear_flag(rows_[i], LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_pos(rows_[i], 0, kListPadTop + rel * kRowHeight);
        } else {
            lv_obj_add_flag(rows_[i], LV_OBJ_FLAG_HIDDEN);
        }
        lv_obj_set_style_bg_opa(cursor_bars_[i],
                                (i == cursor_) ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    }
    if (thumb_) {
        // track 区域 = root 内对称 pad 之间 [kListPadTop, root_h - kListPadBot]。
        // 数学上 = kVisibleRows × kRowHeight,但用 pad 表达更直接体现"上下对称"。
        const int track_h = LV_VER_RES - theme::kStatusBarHeight - kListPadTop - kListPadBot;
        int       thumb_h = (track_h * kVisibleRows) / total;
        if (thumb_h < theme::kThumbMinH) thumb_h = theme::kThumbMinH;
        if (thumb_h > track_h)    thumb_h = track_h;
        const int max_top     = total - kVisibleRows;
        const int thumb_y_max = track_h - thumb_h;
        const int thumb_y     = (max_top > 0) ? (thumb_y_max * viewport_top_ / max_top) : 0;
        lv_obj_set_size(thumb_, theme::kThumbW, thumb_h);
        lv_obj_set_pos(thumb_, LV_HOR_RES - theme::kThumbW - theme::kThumbRightPad,
                       kListPadTop + thumb_y);
    }
}
