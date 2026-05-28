#include "bg_refresh_scene.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <array>
#include <atomic>
#include <cstring>
#include <memory>
#include <new>
#include <vector>

#include "cache.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "frame_view.h"
#include "power_state.h"
#include "status_bar.h"
#include "theme.h"

namespace {
constexpr char kTag[] = "BgRefresh";
constexpr int  kBpr   = FrameView::kWidth / 8;

void PostBgRefreshDone() {
    UiEvent e{};
    e.kind = UiEventKind::kBgRefreshDone;
    evt::Post(e);
}

void PostBgRefreshDoneOnce(const std::shared_ptr<std::atomic<bool>>& done_posted) {
    if (done_posted && done_posted->exchange(true, std::memory_order_acq_rel))
        return;
    PostBgRefreshDone();
}

struct WatcherContext {
    EpdSsd1683*                        epd = nullptr;
    std::shared_ptr<std::atomic<bool>> done_posted;
};

void WatcherEntry(void* arg) {
    std::unique_ptr<WatcherContext> ctx(static_cast<WatcherContext*>(arg));
    auto*                           epd        = ctx ? ctx->epd : nullptr;
    constexpr int                   kTimeoutMs = 8000;
    int                             waited     = 0;
    while (epd && epd->IsRefreshPending() && waited < kTimeoutMs) {
        vTaskDelay(pdMS_TO_TICKS(50));
        waited += 50;
    }
    auto done_posted = ctx ? ctx->done_posted : std::shared_ptr<std::atomic<bool>>();
    PostBgRefreshDoneOnce(done_posted);
    vTaskDelete(nullptr);
}

void UpdateFrameSchedule(int seq, const cache::FrameMeta& meta) {
    power_state::SetCurrentFrameFromMeta(seq, meta);
}

}  // namespace

BgRefreshScene::~BgRefreshScene() = default;

void BgRefreshScene::OnEnter(SceneContext& ctx) {
    done_posted_->store(false, std::memory_order_release);
    previous_screen_seeded_ = SeedPreviousFrame(ctx);
    state_                  = State::kWaiting;
}

void BgRefreshScene::OnExit(SceneContext& ctx) {
    DestroyRoot(ctx, root_, [this] { status_bar_.reset(); });
}

void BgRefreshScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (e.kind != UiEventKind::kSyncFinished || state_ != State::kWaiting)
        return;

    if (!e.u.sync.ok || !e.u.sync.group_changed) {
        Finish();
        return;
    }

    if (!previous_screen_seeded_) {
        ESP_LOGW(kTag, "Previous screen seed incomplete; skip background screen update");
        Finish();
        return;
    }

    state_ = State::kRendering;
    if (!RenderChangedFrame(ctx)) {
        Finish();
    }
}

bool BgRefreshScene::SeedPreviousFrame(SceneContext& ctx) {
    if (!ctx.epd)
        return false;

    std::array<uint8_t, power_state::kStatusBarSnapshotBytes> status_bar{};
    const bool status_ok = power_state::LoadStatusBarSnapshot(status_bar.data(), status_bar.size());
    if (!status_ok) {
        ESP_LOGW(kTag, "No RTC status bar snapshot; partial seed unavailable");
        return false;
    }

    std::string gid;
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ESP_LOGW(kTag, "No cached group to seed");
        return false;
    }

    int content_count = 0;
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ESP_LOGW(kTag, "No cached manifest to seed");
        return false;
    }

    const int seq = power_state::GetCurrentFrameSeq();
    if (seq < 0 || seq >= content_count) {
        ESP_LOGW(kTag, "Cached seq out of range seq=%d count=%d", seq, content_count);
        return false;
    }

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid, seq, raw) || raw.size() != static_cast<size_t>(FrameView::kRawBytes)) {
        ESP_LOGW(kTag, "Seed image miss seq=%d size=%u", seq, static_cast<unsigned>(raw.size()));
        return false;
    }

    const int y = theme::kStatusBarHeight;
    const int h = FrameView::kHeight - y;
    ctx.epd->SeedPreviousRaw1bpp(0, 0, power_state::kStatusBarSnapshotWidth, power_state::kStatusBarSnapshotHeight,
                                 status_bar.data(), status_bar.size());
    ctx.epd->SeedPreviousRaw1bpp(0, y, FrameView::kWidth, h, raw.data() + y * kBpr, h * kBpr);
    return true;
}

bool BgRefreshScene::ResolveCurrentFrame(std::string& gid, int& seq, int& content_count) {
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ESP_LOGW(kTag, "Render skip: no cached group after sync");
        return false;
    }
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ESP_LOGW(kTag, "Render skip: no manifest after sync");
        return false;
    }

    seq = power_state::GetCurrentFrameSeq();
    if (seq < 0 || seq >= content_count) {
        seq = 0;
    }
    return true;
}

bool BgRefreshScene::RenderChangedFrame(SceneContext& ctx) {
    if (!ctx.epd)
        return false;

    std::string gid;
    int         seq           = 0;
    int         content_count = 0;
    if (!ResolveCurrentFrame(gid, seq, content_count))
        return false;

    std::vector<uint8_t> raw;
    if (!cache::ReadFrameImage(gid, seq, raw) || raw.size() != static_cast<size_t>(FrameView::kRawBytes)) {
        ESP_LOGW(kTag, "Render image miss seq=%d size=%u", seq, static_cast<unsigned>(raw.size()));
        return false;
    }

    cache::FrameMeta meta;
    cache::ReadFrameMeta(gid, seq, meta);
    UpdateFrameSchedule(seq, meta);

    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in render");
        return false;
    }

    auto* screen = lv_screen_active();
    root_        = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, theme::kStatusBarHeight);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption(meta.status_bar_text);
    RefreshStatusBarFromSensors(ctx, *status_bar_);
    lv_refr_now(NULL);

    // Background refresh uses LVGL only for the status bar. The frame body is
    // written as raw 1bpp data so it exactly matches the cached screen format.
    const int y = theme::kStatusBarHeight;
    const int h = FrameView::kHeight - y;
    ctx.epd->WriteRaw1bpp(0, y, FrameView::kWidth, h, raw.data() + y * kBpr, h * kBpr);
    ctx.epd->RequestUrgentPartialRefresh();
    ctx.epd->Unlock();

    StartWatcher(ctx.epd);
    return true;
}

void BgRefreshScene::StartWatcher(EpdSsd1683* epd) {
    auto* ctx = new (std::nothrow) WatcherContext{epd, done_posted_};
    if (!ctx) {
        ESP_LOGW(kTag, "Watcher alloc failed; finish immediately");
        Finish();
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&WatcherEntry, "bg_refresh_watch", 2048, ctx, 2, nullptr, 0);
    if (ok != pdPASS) {
        delete ctx;
        ESP_LOGW(kTag, "Watcher create failed; finish immediately");
        Finish();
    }
}

void BgRefreshScene::Finish() {
    if (state_ == State::kDone)
        return;
    state_ = State::kDone;
    PostBgRefreshDoneOnce(done_posted_);
}
