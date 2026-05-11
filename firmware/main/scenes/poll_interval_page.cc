#include "poll_interval_page.h"

#include <memory>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../net/poll_interval_store.h"
#include "../ui/menu_list.h"
#include "../ui/theme.h"

namespace {
struct Preset {
    int         seconds;
    const char* label;
};

constexpr Preset kPresets[] = {
    {30,   "30 秒"},
    {60,   "1 分钟"},
    {300,  "5 分钟"},
    {600,  "10 分钟"},
    {900,  "15 分钟"},
    {1800, "30 分钟"},
    {3600, "1 小时"},
};
constexpr int kPresetCount = sizeof(kPresets) / sizeof(kPresets[0]);
constexpr int kDefaultIdx  = 1;  // 60s

int IndexFromCurrent() {
    const int cur = poll::Get();
    for (int i = 0; i < kPresetCount; ++i) {
        if (kPresets[i].seconds == cur) return i;
    }
    return kDefaultIdx;
}
}  // namespace

PollIntervalPage::PollIntervalPage()  = default;
PollIntervalPage::~PollIntervalPage() = default;

void PollIntervalPage::OnEnter(SceneContext& ctx) {
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
    status_bar_->SetCaption("同步频率");

    std::vector<MenuList::Item> items;
    for (int i = 0; i < kPresetCount; ++i) {
        const int seconds = kPresets[i].seconds;
        items.push_back({kPresets[i].label, [seconds]() { poll::Set(seconds); }});
    }
    menu_ = std::make_unique<MenuList>(root_, std::move(items), IndexFromCurrent());

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}

void PollIntervalPage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    menu_.reset();
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void PollIntervalPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:    menu_->OnUp();   SyncRender(ctx); break;
                case ButtonId::kDown:  menu_->OnDown(); SyncRender(ctx); break;
                case ButtonId::kEnter: menu_->OnEnter(); ctx.stack->RequestPop(); break;
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) {
                ctx.stack->RequestPop();
            }
            break;
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kChargeChanged:
            if (status_bar_) {
                status_bar_->Refresh();
                SyncRender(ctx);
            }
            break;
        default:
            break;
    }
}

void PollIntervalPage::SyncRender(SceneContext& ctx) {
    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}
