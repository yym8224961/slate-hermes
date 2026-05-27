#include "frame_scene.h"

#include <esp_log.h>
#include <cstdio>
#include <vector>

#include "audio_player.h"
#include "boot_splash_scene.h"
#include "cache.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "frame_view.h"
#include "power_state.h"
#include "scene_stack.h"
#include "settings_scene.h"
#include "status_bar.h"
#include "sync_service.h"
#include "theme.h"

namespace {
constexpr char kTag[] = "Frame";
}  // namespace

FrameScene::FrameScene(const char* gid, int content_count) : gid_(gid ? gid : ""), content_count_(content_count) {
    idx_ = power_state::GetCurrentFrameSeq();
    if (content_count_ <= 0)
        content_count_ = 0;
    if (content_count_ > 0 && (idx_ < 0 || idx_ >= content_count_))
        idx_ = 0;
}

FrameScene::~FrameScene() = default;

void FrameScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in OnEnter");
        return;
    }

    auto* screen = lv_screen_active();
    root_        = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    frame_view_ = std::make_unique<FrameView>(root_);

    empty_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(empty_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(empty_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(empty_label_, 8, 0);
    lv_label_set_long_mode(empty_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(empty_label_, LV_HOR_RES - 32);
    lv_label_set_text(empty_label_, "相册暂无内容\n\n请在管理端为本相册添加内容");
    lv_obj_align(empty_label_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);

    status_bar_ = std::make_unique<StatusBar>(root_);

    ctx.epd->Unlock();

    RefreshStatusBarFromSensors(ctx);
    ApplyEmptyState();

    if (!gid_.empty() && content_count_ > 0) {
        LoadFrame(ctx, idx_, /*force_full*/ first_load_full_refresh_, AudioBehavior::RestartIfAvailable);
    } else {
        if (ctx.audio)
            ctx.audio->Stop();
        SyncRender(ctx, /*force_full*/ first_load_full_refresh_);
    }
}

void FrameScene::OnExit(SceneContext& ctx) {
    if (ctx.audio)
        ctx.audio->Stop();
    if (!ctx.epd->Lock(500))
        return;
    frame_view_.reset();
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_        = nullptr;
        empty_label_ = nullptr;
    }
    ctx.epd->Unlock();
}

void FrameScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    PrevFrame(ctx);
                    break;
                case ButtonId::kDown:
                case ButtonId::kEnter:
                    NextFrame(ctx);
                    break;
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    CycleGroup(ctx, /*next=*/false);
                    break;
                case ButtonId::kDown:
                    CycleGroup(ctx, /*next=*/true);
                    break;
                case ButtonId::kEnter:
                    ctx.stack->RequestPush(std::make_unique<SettingsScene>());
                    break;
            }
            break;
        }
        case UiEventKind::kChargeChanged: {
            const auto& c   = e.u.charge;
            int         pct = -1;
            if (!c.no_battery && ctx.read_battery) {
                int mv = 0;
                ctx.read_battery(&mv, &pct);
            }
            if (status_bar_ && status_bar_->SetBattery(pct, c.charging, c.full)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kBatteryUpdated: {
            bool charging = false, full = false;
            if (ctx.read_charge) {
                const auto snap = ctx.read_charge();
                charging        = snap.charging;
                full            = snap.full;
            }
            if (status_bar_ && status_bar_->SetBattery(e.u.battery.pct, charging, full)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kWifiStateChanged: {
            if (status_bar_ && status_bar_->SetWifi(e.u.wifi.connected, e.u.wifi.rssi)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kSyncProgress: {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "下载 %u / %u", e.u.progress.current, e.u.progress.total);
            if (status_bar_ && status_bar_->SetCaption(buf)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kSyncFinished: {
            if (status_bar_ && !cached_status_bar_text_.empty() && status_bar_->SetCaption(cached_status_bar_text_)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kSyncedGroupReady: {
            if (e.u.group.gid[0] == '\0')
                break;
            const bool same_group      = (gid_ == e.u.group.gid);
            const bool content_changed = e.u.group.content_changed;
            if (same_group && !content_changed) {
                content_count_ = e.u.group.content_count > 0 ? e.u.group.content_count : 0;
                if (content_count_ > 0 && (idx_ < 0 || idx_ >= content_count_))
                    idx_ = 0;
                break;
            }
            if (!same_group) {
                RebindGroup(ctx, e.u.group.gid, e.u.group.content_count);
            } else {
                content_count_ = e.u.group.content_count > 0 ? e.u.group.content_count : 0;
                if (content_count_ > 0 && (idx_ < 0 || idx_ >= content_count_))
                    idx_ = 0;
            }
            ApplyEmptyState();
            if (content_count_ > 0) {
                LoadFrame(ctx, idx_, /*force_full*/ true,
                          same_group ? AudioBehavior::StopIfUnavailable : AudioBehavior::RestartIfAvailable);
            } else {
                if (ctx.audio)
                    ctx.audio->Stop();
                SyncRender(ctx, /*force_full*/ true);
            }
            break;
        }
        case UiEventKind::kMinuteTick:
            RefreshStatusBarFromSensors(ctx);
            break;
        case UiEventKind::kUnbound: {
            ESP_LOGW(kTag, "Unbound -> back to BootSplashScene");
            ctx.stack->RequestReplace(std::make_unique<BootSplashScene>());
            break;
        }
        default:
            break;
    }
}

void FrameScene::NextFrame(SceneContext& ctx) {
    if (content_count_ <= 0)
        return;
    idx_ = (idx_ + 1) % content_count_;
    LoadFrame(ctx, idx_, /*force_full*/ false, AudioBehavior::RestartIfAvailable);
}

void FrameScene::PrevFrame(SceneContext& ctx) {
    if (content_count_ <= 0)
        return;
    idx_ = (idx_ - 1 + content_count_) % content_count_;
    LoadFrame(ctx, idx_, /*force_full*/ false, AudioBehavior::RestartIfAvailable);
}

void FrameScene::CycleGroup(SceneContext& ctx, bool next) {
    if (status_bar_) {
        status_bar_->SetCaption(next ? "切换到下一相册..." : "切换到上一相册...");
        SyncRender(ctx, /*force_full*/ false);
    }
    if (next)
        SyncService::Get().CycleNext();
    else
        SyncService::Get().CyclePrev();
}

void FrameScene::RebindGroup(SceneContext& ctx, const char* gid, int content_count) {
    (void)ctx;
    gid_           = gid ? gid : "";
    content_count_ = content_count > 0 ? content_count : 0;
    idx_           = 0;
    power_state::SetCurrentFrameSeq(idx_);
    power_state::SetCurrentFrameSchedule({});
    first_loaded_ = false;
}

void FrameScene::LoadFrame(SceneContext& ctx, int idx, bool force_full, AudioBehavior audio_behavior) {
    if (gid_.empty() || idx < 0 || content_count_ <= 0 || idx >= content_count_)
        return;

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid_, idx, raw) || raw.size() != static_cast<size_t>(FrameView::kRawBytes)) {
        ESP_LOGW(kTag, "LoadFrame %d: image miss/cache (got %u B)", idx, static_cast<unsigned>(raw.size()));
        if (ctx.audio)
            ctx.audio->Stop();
        return;
    }
    cache::FrameMeta meta;
    cache::ReadFrameMeta(gid_, idx, meta);

    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "LoadFrame %d: epd lock timeout", idx);
        return;
    }
    if (status_bar_)
        status_bar_->SetCaption(meta.status_bar_text);
    cached_status_bar_text_ = meta.status_bar_text;
    lv_refr_now(NULL);
    ctx.epd->Unlock();

    if (frame_view_)
        frame_view_->SetFrame(ctx.epd, raw);

    const bool full = force_full || (!first_loaded_ && first_load_full_refresh_);
    first_loaded_   = true;
    if (full)
        ctx.epd->RequestUrgentFullRefresh();
    else
        ctx.epd->RequestUrgentPartialRefresh();

    if (ctx.audio) {
        std::vector<uint8_t> pcm;
        if (cache::ReadFrameAudio(gid_, idx, pcm) && !pcm.empty()) {
            if (audio_behavior == AudioBehavior::RestartIfAvailable) {
                ctx.audio->Play(pcm.data(), pcm.size());
            }
        } else {
            ctx.audio->Stop();
        }
    }

    power_state::CurrentFrameSchedule schedule;
    schedule.dynamic         = meta.has_ttl;
    schedule.server_sync_sec = meta.ttl_sec;
    power_state::SetCurrentFrameSchedule(schedule);
    power_state::SetCurrentFrameSeq(idx);
}

void FrameScene::RefreshStatusBarFromSensors(SceneContext& ctx) {
    if (!status_bar_)
        return;
    bool changed = false;
    if (ctx.wifi_connected && ctx.wifi_rssi) {
        changed |= status_bar_->SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int        pct  = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        changed |= status_bar_->SetBattery(pct, snap.charging, snap.full);
    }
    if (changed)
        SyncRender(ctx, /*force_full*/ false);
}

void FrameScene::ApplyEmptyState() {
    const bool empty = (content_count_ <= 0);
    if (frame_view_) {
        if (empty)
            frame_view_->Hide();
        else
            frame_view_->Show();
    }
    if (empty_label_) {
        if (empty)
            lv_obj_clear_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);
        else
            lv_obj_add_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);
    }
    if (empty && status_bar_) {
        status_bar_->SetCaption("");
        cached_status_bar_text_.clear();
    }
}

void FrameScene::SyncRender(SceneContext& ctx, bool force_full) {
    if (!ctx.epd)
        return;
    if (!ctx.epd->Lock(500)) {
        ESP_LOGW(kTag, "SyncRender: epd lock timeout");
        return;
    }
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    if (force_full)
        ctx.epd->RequestUrgentFullRefresh();
    else
        ctx.epd->RequestUrgentPartialRefresh();
}
