#include "data_sync_page.h"

#include <esp_log.h>
#include <cstdio>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../net/sync_service.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "data_sync";
}

DataSyncPage::DataSyncPage()  = default;
DataSyncPage::~DataSyncPage() = default;

void DataSyncPage::OnEnter(SceneContext& ctx) {
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
    status_bar_->SetCaption("数据同步");
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

    // 中央状态文字 — 初始空闲
    status_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_font(status_lbl_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(status_lbl_, lv_color_black(), 0);
    lv_obj_set_style_text_align(status_lbl_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(status_lbl_, "等待操作");
    lv_obj_align(status_lbl_, LV_ALIGN_CENTER, 0, 0);

    hint_lbl_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_lbl_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint_lbl_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_lbl_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_lbl_, "按确认 返回   长按确认 立即同步");
    lv_obj_align(hint_lbl_, LV_ALIGN_BOTTOM_MID, 0, -16);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void DataSyncPage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_       = nullptr;
        status_lbl_ = nullptr;
        hint_lbl_   = nullptr;
    }
    ctx.epd->Unlock();
}

void DataSyncPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            if (e.u.button.btn == ButtonId::kEnter) ctx.stack->RequestPop();
            break;

        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGI(kTag, "long Enter → trigger sync now");
                SyncService::Get().TriggerNow();
                SetStatus(ctx, "已发起同步,等待结果…");
                SyncRender(ctx);
            }
            break;

        case UiEventKind::kSyncStarted:
            SetStatus(ctx, "同步中…");
            SyncRender(ctx);
            break;

        case UiEventKind::kSyncProgress: {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "下载中  %u / %u",
                          static_cast<unsigned>(e.u.progress.current),
                          static_cast<unsigned>(e.u.progress.total));
            SetStatus(ctx, buf);
            SyncRender(ctx);
            break;
        }

        case UiEventKind::kSyncFinished:
            SetStatus(ctx, e.u.sync.ok ? "同步完成" : "同步失败,稍后重试");
            SyncRender(ctx);
            break;

        default:
            break;
    }
}

void DataSyncPage::SetStatus(SceneContext& ctx, const std::string& text) {
    if (!status_lbl_) return;
    lv_label_set_text(status_lbl_, text.c_str());
    lv_obj_align(status_lbl_, LV_ALIGN_CENTER, 0, 0);
}

void DataSyncPage::SyncRender(SceneContext& ctx) {
    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}
