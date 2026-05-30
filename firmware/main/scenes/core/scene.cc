#include "scenes/core/scene.h"

#include "drivers/display/epd_ssd1683.h"
#include "ui/status_bar.h"

lv_obj_t* Scene::CreateFullscreenRoot() {
    auto* screen = lv_screen_active();
    auto* root   = lv_obj_create(screen);
    lv_obj_set_size(root, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root, 0, 0);
    lv_obj_set_style_bg_color(root, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_clear_flag(root, LV_OBJ_FLAG_SCROLLABLE);
    return root;
}

bool Scene::RefreshStatusBarFromSensors(SceneContext& ctx, StatusBar& status_bar) {
    bool changed = false;
    if (ctx.wifi_connected && ctx.wifi_rssi) {
        changed |= status_bar.SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int        pct  = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        changed |= status_bar.SetBattery(pct, snap.charging, snap.full);
    }
    return changed;
}

bool Scene::RefreshStatusBarAndRender(SceneContext& ctx, StatusBar* status_bar, bool force_full, int timeout_ms) {
    if (!status_bar)
        return false;
    if (!RefreshStatusBarFromSensors(ctx, *status_bar))
        return false;
    return SyncRender(ctx, force_full, timeout_ms);
}

bool Scene::SyncRender(SceneContext& ctx, bool force_full, int timeout_ms) {
    return SyncRender(ctx, {}, force_full, timeout_ms);
}

bool Scene::SyncRender(SceneContext& ctx, std::function<void()> before_refresh, bool force_full, int timeout_ms) {
    if (!ctx.epd || !ctx.epd->Lock(timeout_ms))
        return false;
    if (before_refresh)
        before_refresh();
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    if (force_full)
        ctx.epd->RequestUrgentFullRefresh();
    else
        ctx.epd->RequestUrgentPartialRefresh();
    return true;
}

bool Scene::DestroyRoot(SceneContext& ctx, lv_obj_t*& root, std::function<void()> cleanup, int timeout_ms) {
    if (!ctx.epd || !ctx.epd->Lock(timeout_ms))
        return false;
    if (cleanup)
        cleanup();
    if (root) {
        lv_obj_del(root);
        root = nullptr;
    }
    ctx.epd->Unlock();
    return true;
}
