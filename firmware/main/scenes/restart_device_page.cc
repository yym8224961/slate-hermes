#include "restart_device_page.h"

#include <esp_log.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "Restart";
}

RestartDevicePage::RestartDevicePage()  = default;
RestartDevicePage::~RestartDevicePage() = default;

void RestartDevicePage::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) return;

    auto* screen = lv_screen_active();
    root_        = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("重启设备");
    if (ctx.wifi_connected && ctx.wifi_rssi) {
        status_bar_->SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int        pct  = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        status_bar_->SetBattery(pct, snap.charging || snap.full);
    }

    auto* warn = lv_label_create(root_);
    lv_obj_set_style_text_font(warn, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(warn, lv_color_black(), 0);
    lv_obj_set_style_text_align(warn, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(warn, 8, 0);
    lv_obj_set_width(warn, LV_HOR_RES - 64);
    lv_label_set_long_mode(warn, LV_LABEL_LONG_WRAP);
    lv_label_set_text(warn,
                      "确认要重启设备吗?\n\n"
                      "WiFi 配置和已下载\n"
                      "的图片缓存都保留\n"
                      "重启完成后自动恢复");
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, -8);

    auto* hint = lv_label_create(root_);
    lv_obj_set_style_text_font(hint, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint, "按确认 返回   长按确认 执行");
    lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -16);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}

void RestartDevicePage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void RestartDevicePage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (e.kind == UiEventKind::kButtonShort && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGI(kTag, "Short Enter -> cancel, pop");
        ctx.stack->RequestPop();
        return;
    }
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGW(kTag, "Long Enter -> restart device");
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
    }
}
