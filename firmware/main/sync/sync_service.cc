#include "sync_service.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <sdkconfig.h>

#include <utility>

#include "api_client.h"
#include "board.h"
#include "cache.h"
#include "event_bus.h"
#include "power_state.h"
#include "sntp.h"
#include "time_utils.h"
#include "wifi.h"

namespace {
constexpr char kTag[]           = "Sync";
constexpr int  BIT_TRIGGER      = BIT0;
constexpr int  BIT_STOP         = BIT1;
constexpr int  BIT_CYCLE_NEXT   = BIT2;
constexpr int  BIT_CYCLE_PREV   = BIT3;
constexpr int  BIT_WAKE_REFRESH = BIT4;
constexpr int  kBoundPollSec    = 60;
constexpr int  kStopWaitMs      = 30000;

// unbound 期阶梯退避轮询: 用户在 Web 端输码后快速屏切「等待内容组」。
// bound 后由 SleepManager 允许 deep sleep,设备活跃时 poll 间隔固定 60s。
constexpr int     kUnboundFastPollSec   = 10;  // 前 10 分钟
constexpr int     kUnboundMediumPollSec = 30;  // 10-30 分钟
constexpr int     kUnboundSlowPollSec   = 60;  // 30 分钟-2 小时
constexpr int64_t kUnboundFastMs        = 10LL * 60 * 1000;
constexpr int64_t kUnboundMediumMs      = 30LL * 60 * 1000;
constexpr size_t  kCacheMinFreeBytes    = 1024 * 1024;
constexpr int     kMaxCachedGroups      = 4;

std::string ExistingImageEtag(const std::string& gid, int seq, const std::string& expected_etag) {
    cache::FrameMeta meta;
    if (cache::ReadFrameMeta(gid, seq, meta) && cache::FrameImageExists(gid, seq, meta.image_etag)) {
        return meta.image_etag;
    }
    if (cache::FrameImageExists(gid, seq, expected_etag)) {
        return expected_etag;
    }
    return "";
}

std::string ExistingAudioEtag(const std::string& gid, int seq, const std::string& expected_etag) {
    cache::FrameMeta meta;
    if (cache::ReadFrameMeta(gid, seq, meta) && !meta.audio_etag.empty() &&
        cache::FrameAudioExists(gid, seq, meta.audio_etag)) {
        return meta.audio_etag;
    }
    if (cache::FrameAudioExists(gid, seq, expected_etag)) {
        return expected_etag;
    }
    return "";
}

uint8_t ClampProgressCount(int value) {
    if (value < 0)
        return 0;
    return static_cast<uint8_t>(value > 255 ? 255 : value);
}
}  // namespace

SyncService& SyncService::Get() {
    static SyncService s;
    return s;
}

void SyncService::TaskEntry(void* arg) {
    auto* self = static_cast<SyncService*>(arg);
    self->Loop();
    {
        std::lock_guard<std::mutex> lock(self->task_mutex_);
        if (self->task_handle_ == xTaskGetCurrentTaskHandle())
            self->task_handle_ = nullptr;
    }
    if (self->exit_sem_)
        xSemaphoreGive(self->exit_sem_);
    vTaskDelete(nullptr);
}

void SyncService::Start(std::string wake_reason) {
    if (running_.load(std::memory_order_acquire))
        return;
    {
        std::lock_guard<std::mutex> lock(task_mutex_);
        if (task_handle_) {
            ESP_LOGW(kTag, "Start ignored: previous sync task has not exited");
            return;
        }
    }
    wake_reason_ = std::move(wake_reason);
    std::atomic_thread_fence(std::memory_order_release);
    if (!event_group_) {
        event_group_ = xEventGroupCreate();
        if (!event_group_) {
            ESP_LOGE(kTag, "Failed to create event group");
            return;
        }
    }
    if (!exit_sem_) {
        exit_sem_ = xSemaphoreCreateBinary();
        if (!exit_sem_) {
            ESP_LOGE(kTag, "Failed to create exit semaphore");
            return;
        }
    }
    xSemaphoreTake(exit_sem_, 0);
    running_.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(task_mutex_);
        BaseType_t ok = xTaskCreatePinnedToCore(&TaskEntry, "slate_sync", 10 * 1024, this, 4, &task_handle_, 0);
        if (ok != pdPASS) {
            running_.store(false, std::memory_order_release);
            task_handle_ = nullptr;
            ESP_LOGE(kTag, "sync task create failed");
            return;
        }
    }
}

void SyncService::Stop() {
    const bool was_running = running_.exchange(false, std::memory_order_acq_rel);
    bool       has_task    = false;
    {
        std::lock_guard<std::mutex> lock(task_mutex_);
        has_task = task_handle_ != nullptr;
    }
    if (!was_running && !has_task)
        return;
    if (was_running && event_group_) {
        xEventGroupSetBits(event_group_, BIT_STOP);
    }
    if (exit_sem_ && xSemaphoreTake(exit_sem_, pdMS_TO_TICKS(kStopWaitMs)) != pdTRUE) {
        ESP_LOGW(kTag, "sync task did not exit within %dms", kStopWaitMs);
        return;
    }
    {
        std::lock_guard<std::mutex> lock(task_mutex_);
        task_handle_ = nullptr;
    }
}

void SyncService::TriggerNow() {
    if (event_group_)
        xEventGroupSetBits(event_group_, BIT_TRIGGER);
}

void SyncService::TriggerWakeRefresh() {
    if (event_group_)
        xEventGroupSetBits(event_group_, BIT_WAKE_REFRESH);
}

void SyncService::CycleNext() {
    if (event_group_)
        xEventGroupSetBits(event_group_, BIT_CYCLE_NEXT);
}

void SyncService::CyclePrev() {
    if (event_group_)
        xEventGroupSetBits(event_group_, BIT_CYCLE_PREV);
}

std::string SyncService::CurrentGroupId() const {
    return GetCurrentGroupLocked();
}

std::string SyncService::GetCurrentGroupLocked() const {
    std::lock_guard<std::mutex> lock(current_group_mutex_);
    std::string                 gid = current_group_;
    return gid;
}

void SyncService::SetCurrentGroupLocked(const std::string& gid) {
    std::lock_guard<std::mutex> lock(current_group_mutex_);
    current_group_ = gid;
}

void SyncService::ClearCurrentGroupLocked() {
    std::lock_guard<std::mutex> lock(current_group_mutex_);
    current_group_.clear();
}

int SyncService::NextIntervalSec() const {
    if (was_bound_.load() == BoundState::kBound)
        return kBoundPollSec;
    const int64_t elapsed = time_utils::NowMs() - unbound_since_ms_.load();
    if (elapsed < kUnboundFastMs)
        return kUnboundFastPollSec;
    if (elapsed < kUnboundMediumMs)
        return kUnboundMediumPollSec;
    return kUnboundSlowPollSec;
}

bool SyncService::ShouldStop() const {
    return !running_.load(std::memory_order_acquire);
}

void SyncService::PostSyncedGroupReady(const std::string& gid, const std::string& name, int content_count,
                                       bool content_changed) {
    evt::PostGroupReady(UiEventKind::kSyncedGroupReady, gid, name, content_count, content_changed);
}

// 把 telemetry 准备好。顺便 emit kBatteryUpdated 让 SleepManager 和系统页同步;
// 系统中只有这里周期性读电量,没必要单独再起一个 battery tick。
static api::Telemetry BuildTelemetry(const std::string& current_group, const std::string& wake_reason) {
    api::Telemetry tel;
    uint16_t       mv  = 0;
    uint8_t        pct = 0;
    if (Board::Get().ReadBattery(&mv, &pct)) {
        tel.battery_pct = pct;
        evt::PostBatteryUpdated(mv, pct, 0);
    }
    tel.rssi_dbm            = Wifi::Get().GetRssi();
    tel.fw_version          = CONFIG_APP_PROJECT_VER;
    tel.wake_reason         = wake_reason;
    tel.current_group       = current_group;
    tel.current_content_seq = power_state::CurrentFrameNeedsTimerWake() ? power_state::GetCurrentFrameSeq() : -1;
    if (tel.current_content_seq >= 0) {
        std::string      gid;
        std::string      manifest_etag;
        cache::FrameMeta meta;
        if (cache::ReadStateMeta(gid, manifest_etag) && !gid.empty() &&
            cache::ReadFrameMeta(gid, tel.current_content_seq, meta)) {
            tel.current_content_etag = meta.content_etag;
        }
    }
    tel.manifest_etag = cache::ReadCurrentManifestEtag();
    return tel;
}

bool SyncService::HandleCachedManifestHit(const std::string& gid, const std::string& expected_etag,
                                          const std::string& status_name, int content_count,
                                          const std::string& previous_current, const std::string& selected_group_id,
                                          SyncReason reason) {
    if (!cache::WriteStateMeta(gid, expected_etag))
        return false;
    cache::TouchGroup(gid);
    SetCurrentGroupLocked(gid);
    if (reason == SyncReason::kCycle && previous_current != gid)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchCached, gid, status_name);
    if (previous_current != gid || selected_group_id != gid)
        PostSyncedGroupReady(gid, status_name, content_count, /*content_changed=*/false);
    return true;
}

bool SyncService::HandleNotModifiedManifest(const std::string& gid, const cache::ManifestMeta& cached_meta,
                                            const std::string& status_name, int expected_content_count,
                                            const std::string& previous_current, const std::string& selected_group_id,
                                            SyncReason reason) {
    const bool first_seen = (previous_current != gid || selected_group_id != gid);
    if (!cache::WriteStateMeta(gid, cached_meta.manifest_etag))
        return false;
    cache::TouchGroup(gid);
    SetCurrentGroupLocked(gid);
    if (reason == SyncReason::kCycle && first_seen)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchCached, gid, status_name);
    if (first_seen) {
        const int content_count = expected_content_count >= 0 ? expected_content_count : cached_meta.content_count;
        PostSyncedGroupReady(gid, status_name, content_count, /*content_changed=*/false);
    }
    return true;
}

bool SyncService::DownloadFramesToStage(const std::string& gid, const api::Manifest& manifest,
                                        const std::string& status_name, const std::string& previous_current,
                                        const std::string& selected_group_id, SyncReason reason, int& total_updates) {
    total_updates = 0;
    for (const auto& f : manifest.contents) {
        if (f.id.empty() || f.image_etag.empty())
            continue;
        if (!cache::StagedFrameImageExists(gid, f.seq, f.image_etag))
            ++total_updates;
        if (!f.audio_etag.empty() && !cache::StagedFrameAudioExists(gid, f.seq, f.audio_etag))
            ++total_updates;
    }

    int        done     = 0;
    bool       complete = true;
    const bool current_group_update =
        reason != SyncReason::kCycle && (previous_current == gid || selected_group_id == gid);
    const GroupSyncStatusMode progress_mode = reason == SyncReason::kCycle ? GroupSyncStatusMode::kSwitchDownload
                                              : current_group_update       ? GroupSyncStatusMode::kCurrentUpdate
                                                                           : GroupSyncStatusMode::kStartupDownload;
    const std::string         progress_name = !manifest.group_name.empty() ? manifest.group_name : status_name;
    auto                      post_progress = [&]() {
        const uint8_t cur = ClampProgressCount(done);
        const uint8_t all = ClampProgressCount(total_updates);
        evt::PostGroupSyncStatus(progress_mode, gid, progress_name, cur, all);
        evt::PostSyncProgress(cur, all);
    };
    if (total_updates > 0)
        post_progress();

    bool warned_missing_id = false;
    for (const auto& f : manifest.contents) {
        if (ShouldStop())
            return false;
        if (f.id.empty()) {
            if (!warned_missing_id) {
                ESP_LOGW(kTag, "Frame seq=%d missing id, skip download", f.seq);
                warned_missing_id = true;
            }
            complete = false;
            continue;
        }
        if (f.image_etag.empty()) {
            ESP_LOGW(kTag, "Frame seq=%d missing image_etag, skip commit", f.seq);
            complete = false;
            continue;
        }
        if (!cache::StagedFrameImageExists(gid, f.seq, f.image_etag)) {
            bool          nm               = false;
            const int64_t image_started_ms = time_utils::NowMs();
            const auto    image_if_none    = ExistingImageEtag(gid, f.seq, f.image_etag);
            download_buf_.clear();
            if (api::DownloadContentImage(f.id, image_if_none, download_buf_, nm)) {
                if (nm) {
                    ESP_LOGW(kTag, "Frame %d image returned unexpected 304", f.seq);
                    complete = false;
                } else if (!cache::WriteStagedFrameImage(gid, f.seq, download_buf_, f.image_etag)) {
                    ESP_LOGW(kTag, "Frame %d image write failed", f.seq);
                    complete = false;
                }
            } else {
                ESP_LOGW(kTag, "Frame %d image download failed elapsed=%lldms", f.seq,
                         (long long)(time_utils::NowMs() - image_started_ms));
                complete = false;
            }
            ++done;
            post_progress();
        }
        if (ShouldStop())
            return false;
        if (!f.audio_etag.empty() && !cache::StagedFrameAudioExists(gid, f.seq, f.audio_etag)) {
            bool          nm               = false;
            const int64_t audio_started_ms = time_utils::NowMs();
            const auto    audio_if_none    = ExistingAudioEtag(gid, f.seq, f.audio_etag);
            download_buf_.clear();
            if (api::DownloadContentAudio(f.id, audio_if_none, download_buf_, nm)) {
                if (nm) {
                    ESP_LOGW(kTag, "Frame %d audio returned unexpected 304", f.seq);
                    complete = false;
                } else if (!cache::WriteStagedFrameAudio(gid, f.seq, download_buf_, f.audio_etag)) {
                    ESP_LOGW(kTag, "Frame %d audio write failed", f.seq);
                    complete = false;
                }
            } else {
                ESP_LOGW(kTag, "Frame %d audio download failed elapsed=%lldms", f.seq,
                         (long long)(time_utils::NowMs() - audio_started_ms));
                complete = false;
            }
            ++done;
            post_progress();
        }

        if (cache::StagedFrameImageExists(gid, f.seq, f.image_etag) &&
            (f.audio_etag.empty() || cache::StagedFrameAudioExists(gid, f.seq, f.audio_etag))) {
            cache::FrameMeta fm;
            fm.status_bar_text = f.device_status_bar_text;
            fm.content_etag    = f.content_etag;
            fm.image_etag      = f.image_etag;
            fm.audio_etag      = f.audio_etag;
            fm.has_ttl         = f.has_next_wake_sec && f.next_wake_sec >= 0;
            fm.ttl_sec         = f.next_wake_sec > 0 ? static_cast<uint32_t>(f.next_wake_sec) : 0;
            if (!cache::WriteStagedFrameMeta(gid, f.seq, fm)) {
                ESP_LOGW(kTag, "Frame %d meta write failed", f.seq);
                complete = false;
            }
        } else {
            complete = false;
        }
    }
    return complete;
}

bool SyncService::CommitStagedFrames(const std::string& gid, const api::Manifest& manifest,
                                     const std::string& group_name, const std::string& selected_group_id,
                                     bool current_group_update, SyncReason reason, int total_updates,
                                     int old_content_count) {
    const std::string         synced_name = !manifest.group_name.empty() ? manifest.group_name : group_name;
    const GroupSyncStatusMode saving_mode =
        current_group_update ? GroupSyncStatusMode::kSavingCurrentGroup : GroupSyncStatusMode::kSavingGroup;
    const int total = static_cast<int>(manifest.contents.size());
    int       saved = 0;
    if (total > 0)
        evt::PostGroupSyncStatus(saving_mode, gid, synced_name, 0, ClampProgressCount(total));
    for (const auto& f : manifest.contents) {
        if (!cache::CommitStagedFrame(gid, f.seq, f.image_etag, f.audio_etag)) {
            ESP_LOGW(kTag, "Frame %d stage commit failed", f.seq);
            cache::CleanupFrameStage(gid);
            return false;
        }
        ++saved;
        evt::PostGroupSyncStatus(saving_mode, gid, synced_name, ClampProgressCount(saved), ClampProgressCount(total));
    }
    if (!cache::WriteManifest(gid, manifest.manifest_etag, manifest.contents.size(), synced_name)) {
        ESP_LOGW(kTag, "Manifest write failed, not committing state");
        cache::CleanupFrameStage(gid);
        return false;
    }
    if (!cache::WriteStateMeta(gid, manifest.manifest_etag)) {
        ESP_LOGW(kTag, "State write failed, not switching group");
        cache::CleanupFrameStage(gid);
        return false;
    }
    cache::TouchGroup(gid);
    cache::PruneOldGroups(selected_group_id, gid, kCacheMinFreeBytes, kMaxCachedGroups);
    for (const auto& f : manifest.contents) {
        if (f.audio_etag.empty())
            cache::DeleteFrameAudio(gid, f.seq);
    }
    for (int idx = total; idx < old_content_count; ++idx) {
        cache::DeleteFrameFiles(gid, idx);
    }
    cache::CleanupFrameStage(gid);
    SetCurrentGroupLocked(gid);
    if (reason == SyncReason::kCycle && total_updates == 0)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchCached, gid, synced_name);
    PostSyncedGroupReady(gid, synced_name, static_cast<int>(manifest.contents.size()), /*content_changed=*/true);
    return true;
}

// 拉某 group 的 manifest 并把缺的 frame 落盘。返回 false 表示本轮同步失败，应通过 SyncFinished 通知 UI。
// group_changed 表示是否真的有「内容更新」。
bool SyncService::SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag,
                                        const std::string& group_name, int expected_content_count, SyncReason reason,
                                        bool& group_changed) {
    group_changed = false;
    if (gid.empty())
        return true;
    if (expected_etag.empty()) {
        ESP_LOGE(kTag, "SyncManifestAndFrames: empty expected_etag");
        return false;
    }

    const std::string previous_current = GetCurrentGroupLocked();
    std::string       selected_group_id, selected_etag;
    cache::ReadStateMeta(selected_group_id, selected_etag);

    cache::ManifestMeta cached_meta;
    bool                cached_meta_ok = cache::ReadManifestMeta(gid, cached_meta);
    if (cached_meta_ok && !group_name.empty() && cached_meta.name != group_name) {
        cache::WriteManifest(gid, cached_meta.manifest_etag, cached_meta.content_count, group_name);
        cached_meta_ok = cache::ReadManifestMeta(gid, cached_meta);
    }
    const std::string status_name = !group_name.empty() ? group_name : cached_meta.name;

    if (cached_meta_ok && cached_meta.manifest_etag == expected_etag) {
        const int content_count = expected_content_count >= 0 ? expected_content_count : cached_meta.content_count;
        return HandleCachedManifestHit(gid, expected_etag, status_name, content_count, previous_current,
                                       selected_group_id, reason);
    }

    api::Manifest mf;
    bool          not_modified = false;
    std::string   if_none_match;
    if (cached_meta_ok && !cached_meta.manifest_etag.empty())
        if_none_match = cached_meta.manifest_etag;
    if (!api::GetManifest(gid, if_none_match, mf, not_modified)) {
        ESP_LOGW(kTag, "GetManifest failed");
        return false;
    }
    if (not_modified) {
        return HandleNotModifiedManifest(gid, cached_meta, status_name, expected_content_count, previous_current,
                                         selected_group_id, reason);
    }
    if (ShouldStop())
        return false;

    int old_content_count = 0;
    cache::ReadManifestContentCount(gid, old_content_count);
    if (!cache::BeginFrameStage(gid)) {
        ESP_LOGW(kTag, "Frame stage init failed");
        return false;
    }

    int total_updates = 0;
    if (!DownloadFramesToStage(gid, mf, status_name, previous_current, selected_group_id, reason, total_updates)) {
        ESP_LOGW(kTag, "Manifest sync incomplete, not committing state");
        cache::CleanupFrameStage(gid);
        return false;
    }
    if (ShouldStop()) {
        cache::CleanupFrameStage(gid);
        return false;
    }

    const bool current_group_update =
        reason != SyncReason::kCycle && (previous_current == gid || selected_group_id == gid);
    if (!CommitStagedFrames(gid, mf, group_name, selected_group_id, current_group_update, reason, total_updates,
                            old_content_count)) {
        return false;
    }
    group_changed = true;
    return true;
}

bool SyncService::SyncCurrentContent(const std::string& gid, const api::ContentMeta& f, bool& changed) {
    changed = false;
    if (gid.empty() || f.id.empty() || f.seq < 0 || f.image_etag.empty())
        return false;

    cache::FrameMeta old_meta;
    const bool       old_meta_ok = cache::ReadFrameMeta(gid, f.seq, old_meta);
    cache::FrameMeta next_meta;
    next_meta.status_bar_text = f.device_status_bar_text;
    next_meta.content_etag    = f.content_etag;
    next_meta.image_etag      = f.image_etag;
    next_meta.audio_etag      = f.audio_etag;
    next_meta.has_ttl         = f.has_next_wake_sec && f.next_wake_sec >= 0;
    next_meta.ttl_sec         = f.next_wake_sec > 0 ? static_cast<uint32_t>(f.next_wake_sec) : 0;

    if (old_meta_ok && !f.content_etag.empty() && old_meta.content_etag == f.content_etag &&
        cache::FrameImageExists(gid, f.seq, f.image_etag) &&
        (f.audio_etag.empty() || cache::FrameAudioExists(gid, f.seq, f.audio_etag))) {
        if (old_meta.status_bar_text != next_meta.status_bar_text || old_meta.has_ttl != next_meta.has_ttl ||
            old_meta.ttl_sec != next_meta.ttl_sec || old_meta.image_etag != next_meta.image_etag ||
            old_meta.audio_etag != next_meta.audio_etag) {
            if (!cache::WriteFrameMeta(gid, f.seq, next_meta)) {
                ESP_LOGW(kTag, "Frame %d meta write failed", f.seq);
                return false;
            }
        }
        power_state::SetCurrentFrameFromMeta(f.seq, next_meta);
        changed = old_meta.status_bar_text != next_meta.status_bar_text ||
                  (!old_meta.image_etag.empty() && old_meta.image_etag != next_meta.image_etag);
        return true;
    }

    const bool image_etag_changed =
        !old_meta_ok || (!old_meta.image_etag.empty() && old_meta.image_etag != f.image_etag);
    const bool status_bar_changed = !old_meta_ok || old_meta.status_bar_text != next_meta.status_bar_text;
    bool       image_downloaded   = false;
    if (ShouldStop())
        return false;
    if (!cache::FrameImageExists(gid, f.seq, f.image_etag)) {
        bool       nm            = false;
        const auto image_if_none = ExistingImageEtag(gid, f.seq, f.image_etag);
        download_buf_.clear();
        if (api::DownloadContentImage(f.id, image_if_none, download_buf_, nm)) {
            if (nm) {
                ESP_LOGW(kTag, "Frame %d image returned unexpected 304", f.seq);
                return false;
            }
            if (!cache::WriteFrameImage(gid, f.seq, download_buf_, f.image_etag)) {
                ESP_LOGW(kTag, "Frame %d image write failed", f.seq);
                return false;
            }
            image_downloaded = true;
        } else {
            return false;
        }
    }
    if (f.audio_etag.empty()) {
        cache::DeleteFrameAudio(gid, f.seq);
    } else if (!cache::FrameAudioExists(gid, f.seq, f.audio_etag)) {
        if (ShouldStop())
            return false;
        bool       nm            = false;
        const auto audio_if_none = ExistingAudioEtag(gid, f.seq, f.audio_etag);
        download_buf_.clear();
        if (api::DownloadContentAudio(f.id, audio_if_none, download_buf_, nm)) {
            if (nm) {
                ESP_LOGW(kTag, "Frame %d audio returned unexpected 304", f.seq);
                return false;
            }
            if (cache::WriteFrameAudio(gid, f.seq, download_buf_, f.audio_etag)) {
                // Audio-only current-content updates should update cache without
                // waking the EPD path; "changed" here means visible pixels changed.
            } else {
                ESP_LOGW(kTag, "Frame %d audio write failed", f.seq);
                return false;
            }
        } else {
            ESP_LOGW(kTag, "Frame %d audio download failed", f.seq);
            return false;
        }
    }

    if (!cache::WriteFrameMeta(gid, f.seq, next_meta)) {
        ESP_LOGW(kTag, "Frame %d meta write failed", f.seq);
        return false;
    }
    power_state::SetCurrentFrameFromMeta(f.seq, next_meta);
    changed = image_downloaded || image_etag_changed || status_bar_changed;
    return true;
}

void SyncService::SyncOnce(SyncMode mode) {
    std::string telemetry_group = GetCurrentGroupLocked();
    if (mode == SyncMode::kBackgroundRefresh) {
        power_state::RestoreCurrentFrameScheduleFromCache();
        std::string gid, etag;
        if (cache::ReadStateMeta(gid, etag))
            telemetry_group = gid;
    }
    // Poll 是设备接收远程状态变更的保活通道，不能按本地按键活跃度节流。
    // UI 刷新频率由 epd_display_mode 决定，不在这里控制。

    evt::PostSyncStarted(0);

    api::Telemetry tel = BuildTelemetry(telemetry_group, wake_reason_);
    if (ShouldStop())
        return;

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "Poll failed (offline?)");
        evt::PostSyncFinished(false, false, 0);
        return;
    }
    if (ShouldStop())
        return;
    sntp::ApplyServerTime(state.server_time);
    // 1. bound 翻转:发独立事件让 splash / frame_scene 都能响应。
    const BoundState prev_bound = was_bound_.load();
    const BoundState next_bound = state.bound ? BoundState::kBound : BoundState::kUnbound;
    if (next_bound != prev_bound) {
        if (state.bound) {
            evt::PostSimple(UiEventKind::kBound, 0);
        } else {
            ESP_LOGW(kTag, "Unbound");
            evt::PostUnbound(state.pair_code, 0);
        }
        was_bound_.store(next_bound);
        if (state.bound) {
            unbound_since_ms_.store(0);
        } else {
            unbound_since_ms_.store(time_utils::NowMs());
        }
    }

    // 2. 当前态推 splash:让重启场景的 splash 也能直接拿到正确文案,无需依赖翻转。
    //    (启动时 splash 会先看 kAwaitingPair/kAwaitingGroup 切到正确文案;
    //     SyncManifestAndFrames 后续 emit kSyncedGroupReady 会 RequestReplace 到 FrameScene。)
    if (!state.bound) {
        evt::PostBootStage(BootStage::kAwaitingPair, nullptr, state.pair_code.c_str(), 0);
    } else if (!state.has_group) {
        evt::PostBootStage(BootStage::kAwaitingGroup, nullptr, nullptr, 0);
    }
    // bound + has_group 不发 boot_stage,SyncManifestAndFrames 走 kSyncedGroupReady。

    bool group_changed = false;
    bool sync_ok       = true;
    if (mode == SyncMode::kBackgroundRefresh && state.has_group && state.has_current_content) {
        // server 的 manifest 与本地不一致 → 不能只同步 current_content：那样会让其他帧的
        // 增/删/改丢失，而且如果在这里把 server 的 manifest_etag 写回 cache，
        // 下一轮 SyncManifestAndFrames 会因 etag 匹配直接跳过，缺帧永远不补。
        // 这种情况回退到完整 manifest 同步路径。
        if (tel.manifest_etag != state.manifest_etag) {
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                            SyncReason::kBackgroundRefresh, group_changed);
        } else {
            sync_ok = SyncCurrentContent(state.group_id, state.current_content, group_changed);
            if (sync_ok && group_changed) {
                PostSyncedGroupReady(state.group_id, state.group_name, state.content_count,
                                     /*content_changed=*/true);
            }
        }
    } else if (mode == SyncMode::kBackgroundRefresh && state.has_group) {
        if (tel.manifest_etag != state.manifest_etag) {
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                            SyncReason::kBackgroundRefresh, group_changed);
        } else {
            ESP_LOGW(kTag, "Background refresh missing current_content; keep cached frame schedule");
            power_state::RestoreCurrentFrameScheduleFromCache();
            sync_ok = tel.current_content_seq < 0;
        }
    } else if (mode == SyncMode::kBackgroundRefresh) {
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    } else if (state.has_group) {
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                        SyncReason::kUserActive, group_changed);
    } else {
        // 没选组:清掉 current_group_(scene 等下一次 ready 事件)
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    }

    evt::PostSyncFinished(sync_ok, group_changed, 0);
}

void SyncService::DoCycle(const std::string& direction) {
    evt::PostSyncStarted(0);

    api::DeviceState state;
    if (ShouldStop())
        return;
    if (!api::CycleGroup(direction, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "CycleGroup(%s) failed (offline?)", direction.c_str());
        evt::PostSyncFinished(false, false, 0);
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchFailed, "", "");
        return;
    }
    if (ShouldStop())
        return;

    bool group_changed = false;
    bool sync_ok       = true;
    if (state.has_group) {
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchTarget, state.group_id, state.group_name);
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                        SyncReason::kCycle, group_changed);
    } else {
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    }

    evt::PostSyncFinished(sync_ok, group_changed, 0);
    if (!sync_ok)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kSwitchFailed, state.group_id, state.group_name);
}

void SyncService::Loop() {
    while (running_.load(std::memory_order_acquire)) {
        const int         interval_s = NextIntervalSec();
        const EventBits_t bits       = xEventGroupWaitBits(
            event_group_, BIT_TRIGGER | BIT_STOP | BIT_CYCLE_NEXT | BIT_CYCLE_PREV | BIT_WAKE_REFRESH, pdTRUE, pdFALSE,
            pdMS_TO_TICKS(interval_s * 1000));
        if (bits & BIT_STOP)
            break;
        if (!running_.load(std::memory_order_acquire))
            break;

        // cycle 优先于普通轮询:cycle 后会自然把新 group 的 manifest 拉下来,
        // 不需要再 SyncOnce 一次。
        if (bits & BIT_CYCLE_NEXT) {
            DoCycle("next");
        } else if (bits & BIT_CYCLE_PREV) {
            DoCycle("prev");
        } else if (bits & BIT_WAKE_REFRESH) {
            SyncOnce(SyncMode::kBackgroundRefresh);
        } else {
            SyncOnce(SyncMode::kUserActive);
        }
    }
}
