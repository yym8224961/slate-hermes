#include "settings_scene.h"

#include <esp_log.h>
#include <memory>
#include <utility>

#include "event_bus.h"
#include "scene_stack.h"
#include "epd_ssd1683.h"
#include "menu_list.h"
#include "theme.h"
#include "device_info_page.h"
#include "factory_reset_page.h"
#include "restart_device_page.h"
#include "volume_page.h"

namespace {
constexpr char kTag[] = "Settings";
}

SettingsScene::SettingsScene() = default;
SettingsScene::~SettingsScene() = default;

void SettingsScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in OnEnter");
        return;
    }

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
    status_bar_->SetCaption("设置");

    // 三段语义分组(MenuList 不显式画分隔,靠顺序传达):
    //   偏好    相册音量 / 小智音量
    //   信息    设备信息
    //   危险    重启设备 / 恢复出厂(永远末尾,避免误触)
    std::vector<MenuList::Item> items = {
        {"相册音量", [&ctx]() { ctx.stack->RequestPush(std::make_unique<VolumePage>(VolumePage::Target::kAlbum)); }},
        {"小智音量", [&ctx]() { ctx.stack->RequestPush(std::make_unique<VolumePage>(VolumePage::Target::kXiaozhi)); }},
        {"设备信息", [&ctx]() { ctx.stack->RequestPush(std::make_unique<DeviceInfoPage>()); }},
        {"重启设备", [&ctx]() { ctx.stack->RequestPush(std::make_unique<RestartDevicePage>()); }},
        {"恢复出厂", [&ctx]() { ctx.stack->RequestPush(std::make_unique<FactoryResetPage>()); }},
    };
    menu_ = std::make_unique<MenuList>(root_, std::move(items), saved_cursor_);

    // 首次填状态栏图标（Wi-Fi/电量）
    if (status_bar_) {
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
            status_bar_->SetBattery(pct, snap.charging, snap.full);
        }
    }

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // 子页 OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 自己看 diff>=30% 兜底升 full。
    // 从 frame 进来 diff 必然 >30% 自动 full;settings ↔ 子页之间 partial 即可。
    ctx.epd->RequestUrgentPartialRefresh();
}

void SettingsScene::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    // push 子页时 OnExit 触发,记录光标位置 — 子页 pop 回来 OnEnter 恢复。
    if (menu_) saved_cursor_ = menu_->Cursor();
    menu_.reset();
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void SettingsScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:    menu_->OnUp();   SyncRender(ctx); break;
                case ButtonId::kDown:  menu_->OnDown(); SyncRender(ctx); break;
                case ButtonId::kEnter: menu_->OnEnter(); break;  // RequestPush 由 callback 走,ApplyPending 处理
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGI(kTag, "Long Enter -> pop back to Frame");
                ctx.stack->RequestPop();
            }
            break;
        }
        default:
            break;
    }
}

void SettingsScene::SyncRender(SceneContext& ctx) {
    if (!ctx.epd) return;
    if (!ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // 一律 partial:cursor 移动小 dirty,viewport 滚动也走 partial,
    // 让 EPD 内部按 dirty 比例自决是否兜底升 full,避免每次滚动都强制全屏闪。
    ctx.epd->RequestUrgentPartialRefresh();
}
