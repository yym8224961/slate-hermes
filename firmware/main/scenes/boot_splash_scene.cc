#include "boot_splash_scene.h"

#include <cstdio>
#include <esp_log.h>
#include <memory>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../ui/theme.h"
#include "frame_scene.h"
#include "settings_scene.h"

namespace {
constexpr char kTag[] = "splash";
}

void BootSplashScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "epd lock timeout in OnEnter");
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

    label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(label_, "正在启动…");
    lv_obj_align(label_, LV_ALIGN_CENTER, 0, 0);

    // 应急逃生 hint:同步卡住时让用户能进设置(配网/恢复出厂)
    auto* hint = lv_label_create(root_);
    lv_obj_set_style_text_font(hint, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint, "长按确认 进入设置");
    lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -16);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void BootSplashScene::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    if (root_) {
        lv_obj_del(root_);
        root_  = nullptr;
        label_ = nullptr;
    }
    ctx.epd->Unlock();
}

void BootSplashScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    // 应急逃生:长按 ENTER push 设置页 — 即使同步未完成、网络断开,
    // 用户仍能调音量 / 看设备信息 / 重新配网 / 恢复出厂。
    // 短按按键全部忽略(避免误触发跳出 splash)。
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGI(kTag, "long Enter on splash → push Settings (emergency exit)");
        ctx.stack->RequestPush(std::make_unique<SettingsScene>());
        return;
    }
    if (e.kind == UiEventKind::kSyncProgress && label_) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "正在准备\n%u / %u",
                      e.u.progress.current, e.u.progress.total);
        if (ctx.epd && ctx.epd->Lock(500)) {
            lv_label_set_text(label_, buf);
            lv_obj_align(label_, LV_ALIGN_CENTER, 0, 0);
            lv_refr_now(NULL);
            ctx.epd->Unlock();
            ctx.epd->RequestUrgentPartialRefresh();
        }
        return;
    }
    if (e.kind != UiEventKind::kGroupReady) return;
    ESP_LOGI(kTag, "GroupReady gid=%s frames=%d default=%d → switch to FrameScene",
             e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx);
    ctx.stack->RequestReplace(std::make_unique<FrameScene>(
        e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx));
}
