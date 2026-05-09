#include "menu_list.h"

#include "theme.h"

namespace {
constexpr int kRowHeight  = 44;
constexpr int kListPadTop = 16;   // 状态栏(28)下方再留 16px 让首行不挤
constexpr int kRowPadL    = 32;
constexpr int kRowPadR    = 24;
constexpr int kCursorBarW = 4;
constexpr int kCursorBarH = 22;
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

    labels_.reserve(items_.size());
    cursor_bars_.reserve(items_.size());

    for (size_t i = 0; i < items_.size(); ++i) {
        const int row_y = kListPadTop + static_cast<int>(i) * kRowHeight;

        // 行容器:透明背景,只是为了对齐子元素的逻辑组。
        auto* row = lv_obj_create(root_);
        lv_obj_set_size(row, LV_HOR_RES, kRowHeight);
        lv_obj_set_pos(row, 0, row_y);
        lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_all(row, 0, 0);
        lv_obj_set_style_border_width(row, 0, 0);
        lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

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
        labels_.push_back(lbl);

        // 右侧 chevron(用 ASCII '>' 配合现有 16px 字体即可,不必引大字号)
        auto* chev = lv_label_create(row);
        lv_obj_set_style_text_font(chev, &SourceHanSansSC_Regular_slim, 0);
        lv_obj_set_style_text_color(chev, lv_color_black(), 0);
        lv_label_set_text(chev, ">");
        lv_obj_align(chev, LV_ALIGN_RIGHT_MID, -kRowPadR, 0);
    }
    Redraw();
}

void MenuList::OnUp() {
    if (items_.empty()) return;
    cursor_ = (cursor_ - 1 + static_cast<int>(items_.size())) % static_cast<int>(items_.size());
    Redraw();
}

void MenuList::OnDown() {
    if (items_.empty()) return;
    cursor_ = (cursor_ + 1) % static_cast<int>(items_.size());
    Redraw();
}

void MenuList::OnEnter() {
    if (cursor_ < 0 || cursor_ >= static_cast<int>(items_.size())) return;
    auto& cb = items_[cursor_].on_enter;
    if (cb) cb();
}

void MenuList::Redraw() {
    for (size_t i = 0; i < cursor_bars_.size(); ++i) {
        const bool focused = (static_cast<int>(i) == cursor_);
        lv_obj_set_style_bg_opa(cursor_bars_[i],
                                focused ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
    }
}
