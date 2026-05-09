#include "sync_service.h"

#include <cstring>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <sdkconfig.h>

#include "../app/event_bus.h"
#include "../storage/cache.h"
#include "api_client.h"

namespace {
constexpr char kTag[]            = "Sync";
constexpr int  BIT_TRIGGER       = BIT0;
constexpr int  BIT_STOP          = BIT1;
constexpr int  BIT_CYCLE_NEXT    = BIT2;
constexpr int  BIT_CYCLE_PREV    = BIT3;
}

SyncService& SyncService::Get() {
    static SyncService s;
    return s;
}

void SyncService::TaskEntry(void* arg) {
    static_cast<SyncService*>(arg)->Loop();
    vTaskDelete(nullptr);
}

void SyncService::Start(SyncDeps deps) {
    if (running_.load()) return;
    deps_ = std::move(deps);
    if (!event_group_) {
        event_group_ = xEventGroupCreate();
        configASSERT(event_group_);
    }
    running_.store(true);
    last_user_active_ms_.store(esp_timer_get_time() / 1000);
    xTaskCreatePinnedToCore(&TaskEntry, "slate_sync", 6 * 1024, this, 4, nullptr, 0);
    ESP_LOGI(kTag, "sync service started");
}

void SyncService::Stop() {
    running_.store(false);
    if (event_group_) {
        xEventGroupSetBits(event_group_, BIT_STOP);
    }
}

void SyncService::TriggerNow() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_TRIGGER);
}

void SyncService::MarkUserActive() {
    last_user_active_ms_.store(esp_timer_get_time() / 1000);
}

void SyncService::CycleNext() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_CYCLE_NEXT);
}

void SyncService::CyclePrev() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_CYCLE_PREV);
}

std::string SyncService::CurrentGroupId() const {
    return current_group_;
}

int SyncService::NextIntervalSec() const {
    if (deps_.read_charge) {
        const auto snap = deps_.read_charge();
        if (snap.power_present) return 30;
    }
    const int64_t now_ms          = esp_timer_get_time() / 1000;
    const int64_t since_active_ms = now_ms - last_user_active_ms_.load();
    if (since_active_ms < 5LL * 60 * 1000) return CONFIG_SLATE_DEFAULT_POLL_INTERVAL_S;
    if (since_active_ms < 30LL * 60 * 1000) return CONFIG_SLATE_DEFAULT_POLL_INTERVAL_S * 2;
    return 300;
}

void SyncService::PostGroupReady(const std::string& gid, int frame_count, int default_seq) {
    UiEvent e{};
    e.kind = UiEventKind::kGroupReady;
    std::strncpy(e.u.group.gid, gid.c_str(), sizeof(e.u.group.gid) - 1);
    e.u.group.gid[sizeof(e.u.group.gid) - 1] = '\0';
    e.u.group.frame_count = frame_count;
    e.u.group.default_idx = default_seq;
    evt::Post(e);
}

// 把 telemetry 准备好。
static api::Telemetry BuildTelemetry(const SyncDeps& deps, const std::string& current_group) {
    api::Telemetry tel;
    if (deps.read_battery) {
        int mv = 0, pct = 0;
        if (deps.read_battery(&mv, &pct)) tel.battery_pct = pct;
    }
    if (deps.read_rssi) tel.rssi_dbm = deps.read_rssi();
    tel.fw_version        = CONFIG_APP_PROJECT_VER;
    tel.current_group     = current_group;
    tel.current_frame_seq = deps.current_frame_seq ? deps.current_frame_seq() : 0;
    return tel;
}

// 拉某 group 的 manifest 并把缺的 frame 落盘。group_changed 表示是否真的有"内容更新"。
void SyncService::SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag,
                                        bool& group_changed) {
    group_changed = false;
    if (gid.empty()) return;

    std::string cached_group_id, cached_etag;
    cache::ReadStateMeta(cached_group_id, cached_etag);

    bool need = (gid != cached_group_id) || (expected_etag != cached_etag);
    if (!need) {
        if (current_group_ != gid) {
            current_group_ = gid;
            int frame_count = 0;
            cache::ReadManifestFrameCount(gid, frame_count);
            PostGroupReady(gid, frame_count, 0);
        }
        return;
    }

    api::Manifest mf;
    bool          not_modified = false;
    std::string   if_none_match;
    if (gid == cached_group_id && !cached_etag.empty()) {
        if_none_match = cached_etag;
    }
    if (!api::GetManifest(gid, if_none_match, mf, not_modified)) {
        ESP_LOGW(kTag, "GetManifest failed");
        return;
    }
    if (not_modified) {
        ESP_LOGI(kTag, "manifest 304 not modified");
        current_group_ = gid;
        int frame_count = 0;
        cache::ReadManifestFrameCount(gid, frame_count);
        PostGroupReady(gid, frame_count, 0);
        return;
    }

    const int total = static_cast<int>(mf.frames.size());
    int       done  = 0;
    for (auto& f : mf.frames) {
        if (!cache::FrameImageExists(gid, f.seq, f.image_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadFrameImage(gid, f.seq, "", buf, nm)) {
                cache::WriteFrameImage(gid, f.seq, buf, f.image_etag);
                ESP_LOGI(kTag, "frame %d image cached (%u B)", f.seq, (unsigned)buf.size());
            }
        }
        if (!f.audio_etag.empty() &&
            !cache::FrameAudioExists(gid, f.seq, f.audio_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadFrameAudio(gid, f.seq, "", buf, nm)) {
                cache::WriteFrameAudio(gid, f.seq, buf, f.audio_etag);
            }
        }
        cache::WriteFrameCaption(gid, f.seq, f.caption);
        ++done;
        // 帧级进度,Scene 自己决定显示与否(BootSplash + FrameScene 关心,
        // SettingsScene 等忽略)。clamp 到 0xFF 避免极端 group 溢出。
        UiEvent e{};
        e.kind            = UiEventKind::kSyncProgress;
        e.u.progress.current = static_cast<uint8_t>(done > 255 ? 255 : done);
        e.u.progress.total   = static_cast<uint8_t>(total > 255 ? 255 : total);
        evt::Post(e, 0);
    }
    cache::WriteManifest(gid, mf.group_etag, mf.frames.size(), mf.default_frame_seq);
    cache::WriteStateMeta(gid, mf.group_etag);
    current_group_  = gid;
    group_changed   = true;
    PostGroupReady(gid, static_cast<int>(mf.frames.size()), mf.default_frame_seq);
}

void SyncService::SyncOnce() {
    {
        UiEvent e{};
        e.kind = UiEventKind::kSyncStarted;
        evt::Post(e, 0);
    }

    api::Telemetry tel = BuildTelemetry(deps_, current_group_);

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        ESP_LOGW(kTag, "Poll failed (offline?)");
        UiEvent e{};
        e.kind = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }

    bool group_changed = false;
    if (state.has_group) {
        SyncManifestAndFrames(state.group_id, state.group_etag, group_changed);
    } else {
        // 没选组:清掉 current_group_(scene 等下一次 GroupReady)
        current_group_.clear();
    }

    UiEvent e{};
    e.kind = UiEventKind::kSyncFinished;
    e.u.sync.ok            = true;
    e.u.sync.group_changed = group_changed;
    evt::Post(e, 0);
}

void SyncService::DoCycle(const std::string& direction) {
    {
        UiEvent e{};
        e.kind = UiEventKind::kSyncStarted;
        evt::Post(e, 0);
    }

    api::DeviceState state;
    if (!api::CycleGroup(direction, state)) {
        ESP_LOGW(kTag, "CycleGroup(%s) failed (offline?)", direction.c_str());
        UiEvent e{};
        e.kind = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }

    bool group_changed = false;
    if (state.has_group) {
        ESP_LOGI(kTag, "cycled %s → %s (pos %d/%d)", direction.c_str(),
                 state.group_id.c_str(), state.position_current, state.position_total);
        SyncManifestAndFrames(state.group_id, state.group_etag, group_changed);
    } else {
        ESP_LOGI(kTag, "cycle %s: no groups available", direction.c_str());
        current_group_.clear();
    }

    UiEvent e{};
    e.kind = UiEventKind::kSyncFinished;
    e.u.sync.ok            = true;
    e.u.sync.group_changed = group_changed;
    evt::Post(e, 0);
}

void SyncService::Loop() {
    SyncOnce();

    while (running_.load()) {
        const int interval_s = NextIntervalSec();
        const EventBits_t bits = xEventGroupWaitBits(
            event_group_,
            BIT_TRIGGER | BIT_STOP | BIT_CYCLE_NEXT | BIT_CYCLE_PREV,
            pdTRUE,
            pdFALSE,
            pdMS_TO_TICKS(interval_s * 1000));
        if (bits & BIT_STOP) break;
        if (!running_.load()) break;

        // cycle 优先于普通轮询:cycle 后会自然把新 group 的 manifest 拉下来,
        // 不需要再 SyncOnce 一次。
        if (bits & BIT_CYCLE_NEXT) {
            DoCycle("next");
        } else if (bits & BIT_CYCLE_PREV) {
            DoCycle("prev");
        } else {
            SyncOnce();
        }
    }
}
