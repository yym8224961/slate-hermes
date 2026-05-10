#include "frame_scene.h"

#include <cstdio>
#include <esp_log.h>
#include <vector>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../audio/audio_player.h"
#include "../display/epd_ssd1683.h"
#include "../net/sync_service.h"
#include "../storage/cache.h"
#include "../ui/frame_view.h"
#include "../ui/status_bar.h"
#include "boot_splash_scene.h"
#include "settings_scene.h"

namespace {
constexpr char kTag[] = "frame";
}

FrameScene::FrameScene(const char* gid, int frame_count, int default_idx)
    : gid_(gid ? gid : ""),
      frame_count_(frame_count),
      idx_(default_idx) {
    if (frame_count_ <= 0) frame_count_ = 0;
    if (frame_count_ > 0 && (idx_ < 0 || idx_ >= frame_count_)) idx_ = 0;
}

FrameScene::~FrameScene() = default;

void FrameScene::OnEnter(SceneContext& ctx) {
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

    // FrameView 全屏（400×300）；StatusBar 浮在最上 28px 白底盖一部分。
    // 后创建在上：StatusBar 在 FrameView 之上。
    frame_view_ = std::make_unique<FrameView>(root_);
    status_bar_ = std::make_unique<StatusBar>(root_);

    ctx.epd->Unlock();

    // 首次状态栏数据（caption 由 LoadFrame 内填）
    RefreshStatusBarFromSensors(ctx);

    // 加载第一帧（force_full：清屏底色 + 第一帧的转换需要 full 一次）
    if (!gid_.empty() && frame_count_ > 0) {
        LoadFrame(ctx, idx_, /*force_full*/ true);
    } else {
        // 空 group：留状态栏 + 白底，触发一次 full 让 splash 转过来。
        SyncRender(ctx, /*force_full*/ true);
    }
}

void FrameScene::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    frame_view_.reset();
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void FrameScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:    PrevFrame(ctx); break;
                case ButtonId::kDown:
                case ButtonId::kEnter: NextFrame(ctx); break;
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    ESP_LOGI(kTag, "long Up → cycle group prev");
                    SyncService::Get().CyclePrev();
                    break;
                case ButtonId::kDown:
                    ESP_LOGI(kTag, "long Down → cycle group next");
                    SyncService::Get().CycleNext();
                    break;
                case ButtonId::kEnter:
                    ESP_LOGI(kTag, "long Enter → push Settings");
                    ctx.stack->RequestPush(std::make_unique<SettingsScene>());
                    break;
            }
            break;
        }
        case UiEventKind::kChargeChanged: {
            const auto& c = e.u.charge;
            int pct       = -1;
            if (!c.no_battery && ctx.read_battery) {
                int mv = 0;
                ctx.read_battery(&mv, &pct);
            }
            const bool charging_icon = c.charging || c.full;
            ESP_LOGI(kTag, "ChargeChanged: present=%d charging=%d full=%d no_battery=%d pct=%d",
                     c.present, c.charging, c.full, c.no_battery, pct);
            if (status_bar_->SetBattery(pct, charging_icon)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kBatteryUpdated: {
            if (status_bar_->SetBattery(e.u.battery.pct, false)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kWifiStateChanged: {
            if (status_bar_->SetWifi(e.u.wifi.connected, e.u.wifi.rssi)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kSyncProgress: {
            // 切合集 / 启动后下载期间,caption 临时变进度文字。下次 LoadFrame 自然恢复。
            char buf[64];
            std::snprintf(buf, sizeof(buf), "下载 %u / %u",
                          e.u.progress.current, e.u.progress.total);
            if (status_bar_->SetCaption(buf)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kSyncFinished: {
            // sync 失败时不会走 GroupReady → LoadFrame,caption 残留进度文字。
            // 收到 finished 主动恢复成最近一次 frame caption(LoadFrame 缓存的)。
            if (!e.u.sync.ok && !cached_caption_.empty()) {
                if (status_bar_->SetCaption(cached_caption_)) {
                    SyncRender(ctx, /*force_full*/ false);
                }
            }
            break;
        }
        case UiEventKind::kGroupReady: {
            if (e.u.group.gid[0] == '\0') break;
            if (gid_ != e.u.group.gid) {
                RebindGroup(ctx, e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx);
                LoadFrame(ctx, idx_, /*force_full*/ true);
            } else if (e.u.group.frame_count != frame_count_) {
                // 同 group 但 frame 数变了（增量）— 仅更新计数。
                frame_count_ = e.u.group.frame_count;
                if (idx_ >= frame_count_) {
                    idx_ = 0;
                    LoadFrame(ctx, idx_, /*force_full*/ false);
                }
            }
            break;
        }
        case UiEventKind::kMinuteTick: {
            RefreshStatusBarFromSensors(ctx);
            break;
        }
        case UiEventKind::kUnbound: {
            // Web 端主动解绑(或物理重置后被踢):立即切回 splash 显示新配对码,
            // 避免设备继续展示已经无主的相册。BootSplashScene OnEnter 会读 NVS,
            // 配网凭据仍在 → 进 kInitializing,后续 sync_service poll 推
            // kAwaitingPair(载新 pair_code)切到配对码状态。
            ESP_LOGW(kTag, "kUnbound (pair_code=%s) → back to BootSplashScene",
                     e.u.unbound.pair_code);
            ctx.stack->RequestReplace(std::make_unique<BootSplashScene>());
            break;
        }
        default:
            break;
    }
}

void FrameScene::NextFrame(SceneContext& ctx) {
    if (frame_count_ <= 0) return;
    idx_ = (idx_ + 1) % frame_count_;
    LoadFrame(ctx, idx_, /*force_full*/ false);
}

void FrameScene::PrevFrame(SceneContext& ctx) {
    if (frame_count_ <= 0) return;
    idx_ = (idx_ - 1 + frame_count_) % frame_count_;
    LoadFrame(ctx, idx_, /*force_full*/ false);
}

void FrameScene::RebindGroup(SceneContext& ctx, const char* gid, int frame_count, int default_idx) {
    gid_         = gid ? gid : "";
    frame_count_ = frame_count > 0 ? frame_count : 0;
    idx_         = (frame_count_ > 0 && default_idx >= 0 && default_idx < frame_count_) ? default_idx : 0;
    first_loaded_ = false;
    ESP_LOGI(kTag, "rebind group gid=%s count=%d default=%d", gid_.c_str(), frame_count_, idx_);
}

void FrameScene::LoadFrame(SceneContext& ctx, int idx, bool force_full) {
    if (gid_.empty() || idx < 0 || frame_count_ <= 0 || idx >= frame_count_) return;

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid_, idx, raw) ||
        raw.size() != static_cast<size_t>(FrameView::kRawBytes)) {
        ESP_LOGW(kTag, "LoadFrame %d: image miss/cache (got %u B)", idx,
                 static_cast<unsigned>(raw.size()));
        return;
    }
    std::string caption;
    cache::ReadFrameCaption(gid_, idx, caption);

    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "LoadFrame %d: epd lock timeout", idx);
        return;
    }
    if (frame_view_) {
        frame_view_->SetFrame(raw);
    }
    if (status_bar_) {
        status_bar_->SetCaption(caption);
    }
    cached_caption_ = caption;  // 保存当前 caption,sync 失败/进度显示后用来恢复
    // 同步渲染：在持锁状态下立即跑 LVGL render + flush_cb，把新图写进 EPD buffer。
    // 不同步走 LVGL 异步渲染常在 RefreshTask 50ms debounce 之后才完成，
    // 拿到旧 buffer Diff=0 直接 continue，表现为按键没反应。
    lv_refr_now(NULL);
    ctx.epd->Unlock();

    const bool full = force_full || !first_loaded_;
    first_loaded_   = true;
    if (full) {
        ctx.epd->RequestUrgentFullRefresh();
    } else {
        ctx.epd->RequestUrgentPartialRefresh();
    }
    ESP_LOGI(kTag, "LoadFrame %d caption=%s%s", idx, caption.c_str(), full ? " (full)" : "");

    // 若该 frame 配了 audio，立即播放（中断之前的播放）。
    std::vector<uint8_t> pcm;
    if (ctx.audio && cache::ReadFrameAudio(gid_, idx, pcm) && !pcm.empty()) {
        ctx.audio->Play(pcm.data(), pcm.size());
    }
}

void FrameScene::RefreshStatusBarFromSensors(SceneContext& ctx) {
    if (!status_bar_) return;
    bool changed = false;

    if (ctx.wifi_connected && ctx.wifi_rssi) {
        changed |= status_bar_->SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int pct = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        changed |= status_bar_->SetBattery(pct, snap.charging || snap.full);
    }

    if (changed) SyncRender(ctx, /*force_full*/ false);
}

void FrameScene::SyncRender(SceneContext& ctx, bool force_full) {
    // 状态栏微改也必须同步渲染：异步路径下 50ms debounce 内 LVGL 还没 flush，
    // refresh_task 拿到 prev=cur Diff=0 直接 continue，表现为图标不刷新。
    // 必须在 ui_loop task 上下文调（栈 8KB），其他 task 栈 3584 装不下 LVGL render。
    if (!ctx.epd) return;
    if (!ctx.epd->Lock(500)) {
        ESP_LOGW(kTag, "SyncRender: epd lock timeout");
        return;
    }
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    if (force_full) {
        ctx.epd->RequestUrgentFullRefresh();
    } else {
        ctx.epd->RequestUrgentPartialRefresh();
    }
}
