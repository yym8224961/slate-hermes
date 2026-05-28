#include "settings_scene.h"

#include <esp_log.h>
#include <memory>
#include <utility>

#include "device_info_page.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "factory_reset_page.h"
#include "menu_list.h"
#include "restart_device_page.h"
#include "scene_stack.h"
#include "theme.h"
#include "volume_page.h"

namespace {
constexpr char kTag[] = "Settings";
}

SettingsScene::SettingsScene()  = default;
SettingsScene::~SettingsScene() = default;

void SettingsScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in OnEnter");
        return;
    }

    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("设置");

    // 三段语义分组(MenuList 不显式画分隔,靠顺序传达):
    //   偏好    相册音量 / 小智音量
    //   信息    设备信息
    //   危险    重启设备 / 恢复出厂(永远末尾,避免误触)
    auto*                       stack = ctx.stack;
    std::vector<MenuList::Item> items = {
        {"相册音量", [stack]() { stack->RequestPush(std::make_unique<VolumePage>(VolumePage::Target::kAlbum)); }},
        {"小智音量", [stack]() { stack->RequestPush(std::make_unique<VolumePage>(VolumePage::Target::kXiaozhi)); }},
        {"设备信息", [stack]() { stack->RequestPush(std::make_unique<DeviceInfoPage>()); }},
        {"重启设备", [stack]() { stack->RequestPush(std::make_unique<RestartDevicePage>()); }},
        {"恢复出厂", [stack]() { stack->RequestPush(std::make_unique<FactoryResetPage>()); }},
    };
    menu_ = std::make_unique<MenuList>(root_, std::move(items), saved_cursor_);

    RefreshStatusBarFromSensors(ctx, *status_bar_);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // 子页 OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 自己看 diff>=30% 兜底升 full。
    // 从 frame 进来 diff 必然 >30% 自动 full;settings ↔ 子页之间 partial 即可。
    ctx.epd->RequestUrgentPartialRefresh();
}

void SettingsScene::OnExit(SceneContext& ctx) {
    DestroyRoot(ctx, root_, [this]() {
        // push 子页时 OnExit 触发,记录光标位置 — 子页 pop 回来 OnEnter 恢复。
        if (menu_)
            saved_cursor_ = menu_->Cursor();
        menu_.reset();
        status_bar_.reset();
    });
}

void SettingsScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_ || !menu_)
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    menu_->OnUp();
                    SyncRender(ctx);
                    break;
                case ButtonId::kDown:
                    menu_->OnDown();
                    SyncRender(ctx);
                    break;
                case ButtonId::kEnter:
                    menu_->OnEnter();
                    break;  // RequestPush 由 callback 走,ApplyPending 处理
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            if (e.u.button.btn == ButtonId::kEnter) {
                ctx.stack->RequestPop();
            }
            break;
        }
        default:
            break;
    }
}
