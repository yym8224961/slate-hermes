#include "factory_reset_page.h"

#include <esp_log.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../net/cred_store.h"
#include "../storage/cache.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "FactoryReset";
}

FactoryResetPage::FactoryResetPage()  = default;
FactoryResetPage::~FactoryResetPage() = default;

void FactoryResetPage::OnEnter(SceneContext& ctx) {
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
    status_bar_->SetCaption("恢复出厂");
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

    auto* warn = lv_label_create(root_);
    lv_obj_set_style_text_font(warn, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(warn, lv_color_black(), 0);
    lv_obj_set_style_text_align(warn, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(warn, 8, 0);
    lv_obj_set_width(warn, LV_HOR_RES - 64);
    lv_label_set_long_mode(warn, LV_LABEL_LONG_WRAP);
    lv_label_set_text(warn,
        "确认要恢复出厂吗?\n\n"
        "WiFi 配置 + 设备绑定\n"
        "+ 所有图片缓存 全部清除\n"
        "重启后进入配网模式");
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, -8);

    auto* hint = lv_label_create(root_);
    lv_obj_set_style_text_font(hint, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint, "按确认 返回   长按确认 执行");
    lv_obj_align(hint, LV_ALIGN_BOTTOM_MID, 0, -16);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 看 diff>=30% 兜底升 full。
    ctx.epd->RequestUrgentPartialRefresh();
}

void FactoryResetPage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void FactoryResetPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    // 跟其他子页一致:短按确认 = 返回,长按确认 = 执行(危险动作)。
    // UP/DOWN 短按忽略(防误触)。
    if (e.kind == UiEventKind::kButtonShort && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGI(kTag, "Short Enter -> cancel, pop");
        ctx.stack->RequestPop();
        return;
    }
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGW(kTag, "Long Enter -> factory reset: clear NVS + format littlefs + reboot");
        // 顺序: NVS 清干净后 format LittleFS。两步任一失败都继续 esp_restart,
        // 防止用户卡在 settings 不知所措;下次启动 InitNetwork 会按当时状态决定下一步。
        cred::Clear();
        cache::FormatAll();
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
    }
}
