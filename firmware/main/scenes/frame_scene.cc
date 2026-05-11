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
#include "../ui/theme.h"
#include "boot_splash_scene.h"
#include "settings_scene.h"

namespace {
constexpr char kTag[] = "Frame";
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

    // FrameView 全屏（400×300）；StatusBar 浮在最上 24px 白底盖一部分。
    // 后创建在上：StatusBar 在 FrameView 之上。
    frame_view_ = std::make_unique<FrameView>(root_);

    // 空相册提示：居中文案,frame_view 之上 / status_bar 之下。
    empty_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(empty_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(empty_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(empty_label_, 8, 0);
    lv_label_set_long_mode(empty_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(empty_label_, LV_HOR_RES - 32);
    lv_label_set_text(empty_label_, "相册暂无图片\n\n请在管理端为本相册添加图片");
    lv_obj_align(empty_label_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);

    status_bar_ = std::make_unique<StatusBar>(root_);

    ctx.epd->Unlock();

    // 首次状态栏数据（caption 由 LoadFrame 内填）
    RefreshStatusBarFromSensors(ctx);

    ApplyEmptyState();

    // 加载第一帧（force_full：清屏底色 + 第一帧的转换需要 full 一次）
    if (!gid_.empty() && frame_count_ > 0) {
        LoadFrame(ctx, idx_, /*force_full*/ true);
    } else {
        // 空 group：留状态栏 + 白底 + 空相册提示，触发一次 full 让 splash 转过来。
        SyncRender(ctx, /*force_full*/ true);
    }
}

void FrameScene::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
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
                case ButtonId::kUp:    PrevFrame(ctx); break;
                case ButtonId::kDown:
                case ButtonId::kEnter: NextFrame(ctx); break;
            }
            break;
        }
        case UiEventKind::kButtonLong: {
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    ESP_LOGI(kTag, "Long Up -> cycle group prev");
                    SyncService::Get().CyclePrev();
                    break;
                case ButtonId::kDown:
                    ESP_LOGI(kTag, "Long Down -> cycle group next");
                    SyncService::Get().CycleNext();
                    break;
                case ButtonId::kEnter:
                    ESP_LOGI(kTag, "Long Enter -> push Settings");
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
            ESP_LOGI(kTag, "ChargeChanged: present=%d charging=%d full=%d no_battery=%d pct=%d",
                     c.present, c.charging, c.full, c.no_battery, pct);
            if (status_bar_->SetBattery(pct, c.charging, c.full)) {
                SyncRender(ctx, /*force_full*/ false);
            }
            break;
        }
        case UiEventKind::kBatteryUpdated: {
            // SyncService 在每轮 poll 上报 telemetry 时 emit 此事件,pct 来自 ADC。
            // 充电时 ADC 数据虚高,把当前 charge 状态查出来交给 status_bar,
            // 由其内部策略决定是否显示 pct(满电 100%、充电中 "--"、否则真实 %)。
            bool charging = false, full = false;
            if (ctx.read_charge) {
                const auto snap = ctx.read_charge();
                charging        = snap.charging;
                full            = snap.full;
            }
            if (status_bar_->SetBattery(e.u.battery.pct, charging, full)) {
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
            const bool same_group     = (gid_ == e.u.group.gid);
            const bool content_changed = e.u.group.content_changed;
            // 同 group 且服务端确认无变化(fast-path/304):屏幕已经是最新,不刷新省电。
            // 仍同步一下 frame_count_(理论上不变,保险),不动 idx_/不重绘。
            if (same_group && !content_changed) {
                frame_count_ = e.u.group.frame_count > 0 ? e.u.group.frame_count : 0;
                if (frame_count_ > 0 && (idx_ < 0 || idx_ >= frame_count_)) idx_ = 0;
                break;
            }
            if (!same_group) {
                RebindGroup(ctx, e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx);
            } else {
                // 同 group 但内容真变了(新增/修改/删除帧):sync_service 已把变化的 frame
                // 重写入 cache,这里必须强制刷新当前帧,否则屏幕会停留在旧图。
                frame_count_ = e.u.group.frame_count > 0 ? e.u.group.frame_count : 0;
                if (frame_count_ > 0 && (idx_ < 0 || idx_ >= frame_count_)) idx_ = 0;
            }
            ApplyEmptyState();
            if (frame_count_ > 0) {
                LoadFrame(ctx, idx_, /*force_full*/ true);
            } else {
                SyncRender(ctx, /*force_full*/ true);
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
            ESP_LOGW(kTag, "Unbound (pair_code=%s) -> back to BootSplashScene",
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
    ESP_LOGI(kTag, "Rebind group: gid=%s count=%d default=%d", gid_.c_str(), frame_count_, idx_);
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
    if (status_bar_) {
        status_bar_->SetCaption(caption);
    }
    cached_caption_ = caption;  // 保存当前 caption,sync 失败/进度显示后用来恢复
    // 先把状态栏渲染进 buffer，再写图像：LVGL 只渲染脏区域，不会覆盖后续
    // WriteRaw1bpp 写入的内容区。若顺序颠倒，lv_refr_now 会把状态栏区以外的
    // 旧像素写入 buffer，覆盖刚写入的帧数据。
    lv_refr_now(NULL);
    ctx.epd->Unlock();

    // 图像直接写入 EPD framebuffer，绕过 LVGL I1→RGB565→1bpp 往返转换。
    if (frame_view_) {
        frame_view_->SetFrame(ctx.epd, raw);
    }

    const bool full = force_full || !first_loaded_;
    first_loaded_   = true;
    if (full) {
        ctx.epd->RequestUrgentFullRefresh();
    } else {
        ctx.epd->RequestUrgentPartialRefresh();
    }
    ESP_LOGI(kTag, "LoadFrame %d: caption=%s%s", idx, caption.c_str(), full ? " (full)" : "");

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
        changed |= status_bar_->SetBattery(pct, snap.charging, snap.full);
    }

    if (changed) SyncRender(ctx, /*force_full*/ false);
}

void FrameScene::ApplyEmptyState() {
    const bool empty = (frame_count_ <= 0);
    if (frame_view_) {
        if (empty) frame_view_->Hide();
        else       frame_view_->Show();
    }
    if (empty_label_) {
        if (empty) lv_obj_clear_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);
        else       lv_obj_add_flag(empty_label_, LV_OBJ_FLAG_HIDDEN);
    }
    if (empty && status_bar_) {
        // 避免上一组的标题残留在状态栏。
        status_bar_->SetCaption("");
        cached_caption_.clear();
    }
}

void FrameScene::SyncRender(SceneContext& ctx, bool force_full) {
    // 状态栏微改也必须同步渲染：异步路径下 50 ms debounce 内 LVGL 还没 flush，
    // refresh_task 拿到 prev=cur Diff=0 直接 continue，表现为图标不刷新。
    // 必须在 ui_loop task 上下文调（栈 8 KB），其他 task 栈 3584 装不下 LVGL render。
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
