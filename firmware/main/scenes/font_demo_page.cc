#include "font_demo_page.h"

#include <esp_log.h>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "font_demo";

// 测试文本 — 故意覆盖典型 UI 中文 + 数字 + 标点。子集字体只有 89 个字 + ASCII,
// 出现的所有字都应该有字模。如果某字体显示豆腐块,说明它没收录,字体覆盖度低。
constexpr const char* kBody =
    "正在准备  工程车合集\n"
    "电量充电中  已接电源\n"
    "下载完成  同步进度 100%\n"
    "设备信息  数据同步";

struct DemoFont {
    const char*       name;
    const lv_font_t*  font;
};

// 2 个候选 — 第 0 个是当前生产字体(中文正文),作为基准对照;
// 第 1 个 FusionPixel 12 已在状态栏百分比生产用,留位置以便后续考虑替换正文字体。
const DemoFont kFonts[] = {
    {"SourceHanSans 16",  &SourceHanSansSC_Regular_slim},
    {"FusionPixel 12",    &FusionPixel_12},
};
constexpr int kFontCount = sizeof(kFonts) / sizeof(kFonts[0]);
}  // namespace

FontDemoPage::FontDemoPage()  = default;
FontDemoPage::~FontDemoPage() = default;

void FontDemoPage::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) return;

    auto* screen = lv_screen_active();
    root_ = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("字体演示");
    if (ctx.wifi_connected && ctx.wifi_rssi) {
        status_bar_->SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int pct = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        status_bar_->SetBattery(pct, snap.charging || snap.full);
    }

    // 当前字体名 — 用思源固定字体,方便辨认
    name_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_font(name_lbl_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(name_lbl_, lv_color_black(), 0);
    lv_obj_set_style_text_align(name_lbl_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(name_lbl_, LV_ALIGN_TOP_MID, 0, theme::kStatusBarHeight + 12);

    // 测试文本 — 字体跟随 idx_ 变化
    body_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_color(body_lbl_, lv_color_black(), 0);
    lv_obj_set_style_text_align(body_lbl_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(body_lbl_, 8, 0);
    lv_obj_set_width(body_lbl_, LV_HOR_RES - 32);
    lv_label_set_long_mode(body_lbl_, LV_LABEL_LONG_WRAP);
    lv_label_set_text(body_lbl_, kBody);
    lv_obj_align(body_lbl_, LV_ALIGN_CENTER, 0, 4);

    hint_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_lbl_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint_lbl_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_lbl_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_lbl_, "上/下 切字体   按确认 返回   长按确认 全刷");
    lv_obj_align(hint_lbl_, LV_ALIGN_BOTTOM_MID, 0, -10);

    ApplyFont();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void FontDemoPage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_     = nullptr;
        name_lbl_ = nullptr;
        body_lbl_ = nullptr;
        hint_lbl_ = nullptr;
    }
    ctx.epd->Unlock();
}

void FontDemoPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    idx_ = (idx_ - 1 + kFontCount) % kFontCount;
                    ApplyFont();
                    SyncRender(ctx, false);
                    ESP_LOGI(kTag, "switch font idx=%d %s", idx_, kFonts[idx_].name);
                    break;
                case ButtonId::kDown:
                    idx_ = (idx_ + 1) % kFontCount;
                    ApplyFont();
                    SyncRender(ctx, false);
                    ESP_LOGI(kTag, "switch font idx=%d %s", idx_, kFonts[idx_].name);
                    break;
                case ButtonId::kEnter:
                    // 短按确认 = 返回(避免误触发全刷,EPD 全刷需 5s)
                    ctx.stack->RequestPop();
                    break;
            }
            break;

        case UiEventKind::kButtonLong:
            // 长按确认 = 全屏刷新清残影 — 多次切字体后再看现状
            if (e.u.button.btn == ButtonId::kEnter) SyncRender(ctx, true);
            break;

        default:
            break;
    }
}

void FontDemoPage::ApplyFont() {
    if (!body_lbl_ || !name_lbl_) return;
    const auto& f = kFonts[idx_];
    lv_obj_set_style_text_font(body_lbl_, f.font, 0);
    lv_label_set_text(name_lbl_, f.name);
    lv_obj_align(name_lbl_, LV_ALIGN_TOP_MID, 0, theme::kStatusBarHeight + 12);
    lv_obj_align(body_lbl_, LV_ALIGN_CENTER, 0, 4);
}

void FontDemoPage::SyncRender(SceneContext& ctx, bool force_full) {
    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    if (force_full) ctx.epd->RequestUrgentFullRefresh();
    else            ctx.epd->RequestUrgentPartialRefresh();
}
