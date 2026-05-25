#include "sync_service.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <sdkconfig.h>
#include <cstring>

#include <utility>

#include "api_client.h"
#include "cache.h"
#include "event_bus.h"
#include "power_state.h"
#include "sntp.h"

namespace {
constexpr char kTag[]           = "Sync";
constexpr int  BIT_TRIGGER      = BIT0;
constexpr int  BIT_STOP         = BIT1;
constexpr int  BIT_CYCLE_NEXT   = BIT2;
constexpr int  BIT_CYCLE_PREV   = BIT3;
constexpr int  BIT_WAKE_REFRESH = BIT4;
constexpr int  kBoundPollSec    = 60;

// unbound 期阶梯退避轮询: 用户在 Web 端输码后快速屏切「等待相册」。
// bound 后由 SleepManager 允许 deep sleep,设备活跃时 poll 间隔固定 60s。
constexpr int        kUnboundFastPollSec            = 10;  // 前 10 分钟
constexpr int        kUnboundMediumPollSec          = 30;  // 10-30 分钟
constexpr int        kUnboundSlowPollSec            = 60;  // 30 分钟-2 小时
constexpr int64_t    kUnboundFastMs                 = 10LL * 60 * 1000;
constexpr int64_t    kUnboundMediumMs               = 30LL * 60 * 1000;
constexpr TickType_t kCurrentGroupMutexTimeoutTicks = pdMS_TO_TICKS(200);

class MutexLockGuard {
   public:
    MutexLockGuard(SemaphoreHandle_t mutex, TickType_t timeout_ticks)
        : mutex_(mutex), locked_(mutex && xSemaphoreTake(mutex, timeout_ticks) == pdTRUE) {
    }
    ~MutexLockGuard() {
        if (locked_)
            xSemaphoreGive(mutex_);
    }
    MutexLockGuard(const MutexLockGuard&)            = delete;
    MutexLockGuard& operator=(const MutexLockGuard&) = delete;
    bool            locked() const {
        return locked_;
    }

   private:
    SemaphoreHandle_t mutex_  = nullptr;
    bool              locked_ = false;
};

void UpdateCurrentFrameScheduleFromMeta(int seq, const cache::FrameMeta& meta) {
    power_state::CurrentFrameSchedule schedule;
    schedule.dynamic         = meta.has_ttl;
    schedule.server_sync_sec = meta.ttl_sec;
    power_state::SetCurrentFrameSchedule(schedule);
    power_state::SetCurrentFrameSeq(seq);
}
}  // namespace

SyncService& SyncService::Get() {
    static SyncService s;
    return s;
}

void SyncService::TaskEntry(void* arg) {
    static_cast<SyncService*>(arg)->Loop();
    vTaskDelete(nullptr);
}

void SyncService::Start(SyncDeps deps) {
    if (running_.load())
        return;
    deps_ = std::move(deps);
    if (!current_group_mutex_) {
        current_group_mutex_ = xSemaphoreCreateMutex();
        if (!current_group_mutex_) {
            ESP_LOGE(kTag, "Failed to create current_group mutex");
            return;
        }
    }
    if (!event_group_) {
        event_group_ = xEventGroupCreate();
        if (!event_group_) {
            ESP_LOGE(kTag, "Failed to create event group");
            return;
        }
    }
    running_.store(true);
    BaseType_t ok = xTaskCreatePinnedToCore(&TaskEntry, "slate_sync", 10 * 1024, this, 4, nullptr, 0);
    if (ok != pdPASS) {
        running_.store(false);
        ESP_LOGE(kTag, "sync task create failed");
        return;
    }
    ESP_LOGI(kTag, "Sync service started");
}

void SyncService::Stop() {
    running_.store(false);
    if (event_group_) {
        xEventGroupSetBits(event_group_, BIT_STOP);
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
    if (!current_group_mutex_)
        return current_group_;
    MutexLockGuard lock(current_group_mutex_, kCurrentGroupMutexTimeoutTicks);
    if (!lock.locked()) {
        ESP_LOGW(kTag, "current_group mutex timeout on read");
        return "";
    }
    std::string gid = current_group_;
    return gid;
}

void SyncService::SetCurrentGroupLocked(const std::string& gid) {
    if (!current_group_mutex_) {
        current_group_ = gid;
        return;
    }
    MutexLockGuard lock(current_group_mutex_, kCurrentGroupMutexTimeoutTicks);
    if (!lock.locked()) {
        ESP_LOGW(kTag, "current_group mutex timeout on write");
        return;
    }
    current_group_ = gid;
}

void SyncService::ClearCurrentGroupLocked() {
    if (!current_group_mutex_) {
        current_group_.clear();
        return;
    }
    MutexLockGuard lock(current_group_mutex_, kCurrentGroupMutexTimeoutTicks);
    if (!lock.locked()) {
        ESP_LOGW(kTag, "current_group mutex timeout on clear");
        return;
    }
    current_group_.clear();
}

int SyncService::NextIntervalSec() const {
    if (was_bound_.load() == BoundState::kBound)
        return kBoundPollSec;
    const int64_t elapsed = (esp_timer_get_time() / 1000) - unbound_since_ms_.load();
    if (elapsed < kUnboundFastMs)
        return kUnboundFastPollSec;
    if (elapsed < kUnboundMediumMs)
        return kUnboundMediumPollSec;
    return kUnboundSlowPollSec;
}

void SyncService::PostSyncedGroupReady(const std::string& gid, const std::string& name, int content_count,
                                       bool content_changed) {
    UiEvent e{};
    e.kind = UiEventKind::kSyncedGroupReady;
    std::strncpy(e.u.group.gid, gid.c_str(), sizeof(e.u.group.gid) - 1);
    e.u.group.gid[sizeof(e.u.group.gid) - 1] = '\0';
    std::strncpy(e.u.group.name, name.c_str(), sizeof(e.u.group.name) - 1);
    e.u.group.name[sizeof(e.u.group.name) - 1] = '\0';
    e.u.group.content_count                    = content_count;
    e.u.group.content_changed                  = content_changed;
    evt::Post(e);
}

// 把 telemetry 准备好。顺便 emit kBatteryUpdated 让 SleepManager 和系统页同步;
// 系统中只有这里周期性读电量,没必要单独再起一个 battery tick。
static api::Telemetry BuildTelemetry(const SyncDeps& deps, const std::string& current_group) {
    api::Telemetry tel;
    if (deps.read_battery) {
        int mv = 0, pct = 0;
        if (deps.read_battery(&mv, &pct)) {
            tel.battery_pct = pct;
            UiEvent e{};
            e.kind          = UiEventKind::kBatteryUpdated;
            e.u.battery.mv  = mv;
            e.u.battery.pct = pct;
            evt::Post(e, 0);
        }
    }
    if (deps.read_rssi)
        tel.rssi_dbm = deps.read_rssi();
    tel.fw_version = CONFIG_APP_PROJECT_VER;
    if (deps.wake_reason)
        tel.wake_reason = deps.wake_reason();
    tel.current_group = current_group;
    if (deps.current_content_seq)
        tel.current_content_seq = deps.current_content_seq();
    if (deps.current_content_etag)
        tel.current_content_etag = deps.current_content_etag();
    if (deps.manifest_etag)
        tel.manifest_etag = deps.manifest_etag();
    return tel;
}

// 拉某 group 的 manifest 并把缺的 frame 落盘。返回 false 表示本轮同步失败，应通过 SyncFinished 通知 UI。
// group_changed 表示是否真的有「内容更新」。
bool SyncService::SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag, bool& group_changed) {
    group_changed = false;
    if (gid.empty())
        return true;

    if (expected_etag.empty()) {
        ESP_LOGE(kTag, "SyncManifestAndFrames: empty expected_etag for gid=%s", gid.c_str());
        return false;
    }

    std::string cached_group_id, cached_etag;
    cache::ReadStateMeta(cached_group_id, cached_etag);

    bool need = (gid != cached_group_id) || (expected_etag != cached_etag);
    if (!need) {
        if (GetCurrentGroupLocked() != gid) {
            SetCurrentGroupLocked(gid);
            int content_count = 0;
            cache::ReadManifestContentCount(gid, content_count);
            // 内容没变,只是 splash → frame_scene 首次切换需要 hint;不刷屏。
            // name 留空，下一轮 manifest 拉成功后会用真实名字补一次。
            PostSyncedGroupReady(gid, "", content_count, /*content_changed=*/false);
        }
        return true;
    }

    api::Manifest mf;
    bool          not_modified = false;
    std::string   if_none_match;
    if (gid == cached_group_id && !cached_etag.empty()) {
        if_none_match = cached_etag;
    }
    if (!api::GetManifest(gid, if_none_match, mf, not_modified)) {
        ESP_LOGW(kTag, "GetManifest failed");
        return false;
    }
    if (not_modified) {
        ESP_LOGI(kTag, "Manifest 304 not modified");
        const bool first_seen = (GetCurrentGroupLocked() != gid);
        SetCurrentGroupLocked(gid);
        if (first_seen) {
            int content_count = 0;
            cache::ReadManifestContentCount(gid, content_count);
            // 304 → server 没下发新 manifest，没有 group_name。留空让 UI 兜底。
            PostSyncedGroupReady(gid, "", content_count, /*content_changed=*/false);
        }
        return true;
    }

    int old_content_count = 0;
    cache::ReadManifestContentCount(gid, old_content_count);

    const int total    = static_cast<int>(mf.contents.size());
    int       done     = 0;
    bool      complete = true;
    // 防日志噪音：同一 gid 的协议不匹配只 warn 一次/轮同步，避免每 tick 反复刷屏。
    // 不用 static：切组后应重新允许打 warn，便于用户修复数据后确认日志恢复。
    std::string warned_gid;
    for (auto& f : mf.contents) {
        // 本地缓存按 (gid, seq) 维度，HTTP URL 用稳定 id。
        if (f.id.empty()) {
            if (warned_gid != gid) {
                ESP_LOGW(kTag, "Frame seq=%d 缺 id（gid=%s），跳过下载", f.seq, gid.c_str());
                warned_gid = gid;
            }
            ++done;
            complete = false;
            UiEvent e{};
            e.kind               = UiEventKind::kSyncProgress;
            e.u.progress.current = static_cast<uint8_t>(done > 255 ? 255 : done);
            e.u.progress.total   = static_cast<uint8_t>(total > 255 ? 255 : total);
            evt::Post(e, 0);
            continue;
        }
        if (f.image_etag.empty()) {
            ESP_LOGW(kTag, "Frame seq=%d missing image_etag, skip commit", f.seq);
            complete = false;
            ++done;
            UiEvent e{};
            e.kind               = UiEventKind::kSyncProgress;
            e.u.progress.current = static_cast<uint8_t>(done > 255 ? 255 : done);
            e.u.progress.total   = static_cast<uint8_t>(total > 255 ? 255 : total);
            evt::Post(e, 0);
            continue;
        }
        if (!cache::FrameImageExists(gid, f.seq, f.image_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadContentImage(f.id, "", buf, nm)) {
                if (cache::WriteFrameImage(gid, f.seq, buf, f.image_etag)) {
                    ESP_LOGI(kTag, "Frame %d image cached (%u B)", f.seq, (unsigned)buf.size());
                } else {
                    ESP_LOGW(kTag, "Frame %d image write failed", f.seq);
                    complete = false;
                }
            } else {
                complete = false;
            }
        }
        if (f.audio_etag.empty()) {
            cache::DeleteFrameAudio(gid, f.seq);
        } else if (!cache::FrameAudioExists(gid, f.seq, f.audio_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadContentAudio(f.id, "", buf, nm)) {
                if (!cache::WriteFrameAudio(gid, f.seq, buf, f.audio_etag)) {
                    ESP_LOGW(kTag, "Frame %d audio write failed", f.seq);
                    complete = false;
                }
            } else {
                ESP_LOGW(kTag, "Frame %d audio download failed", f.seq);
                complete = false;
            }
        }

        if (cache::FrameImageExists(gid, f.seq, f.image_etag) &&
            (f.audio_etag.empty() || cache::FrameAudioExists(gid, f.seq, f.audio_etag))) {
            cache::FrameMeta fm;
            fm.status_bar_text = f.device_status_bar_text;
            fm.content_etag    = f.content_etag;
            fm.has_ttl         = f.has_next_wake_sec && f.next_wake_sec >= 0;
            fm.ttl_sec         = f.next_wake_sec > 0 ? static_cast<uint32_t>(f.next_wake_sec) : 0;
            if (!cache::WriteFrameMeta(gid, f.seq, fm)) {
                ESP_LOGW(kTag, "Frame %d meta write failed", f.seq);
                complete = false;
            }
        } else {
            complete = false;
        }
        ++done;
        // 帧级进度,Scene 自己决定显示与否(BootSplash + FrameScene 关心,
        // SettingsScene 等忽略)。clamp 到 0xFF 避免极端 group 溢出。
        UiEvent e{};
        e.kind               = UiEventKind::kSyncProgress;
        e.u.progress.current = static_cast<uint8_t>(done > 255 ? 255 : done);
        e.u.progress.total   = static_cast<uint8_t>(total > 255 ? 255 : total);
        evt::Post(e, 0);
    }
    if (!complete) {
        ESP_LOGW(kTag, "Manifest sync incomplete, not committing state gid=%s etag=%s", gid.c_str(),
                 mf.manifest_etag.c_str());
        return false;
    }
    for (int idx = total; idx < old_content_count; ++idx) {
        cache::DeleteFrameFiles(gid, idx);
    }
    if (!cache::WriteManifest(gid, mf.manifest_etag, mf.contents.size())) {
        ESP_LOGW(kTag, "Manifest write failed, not committing state gid=%s etag=%s", gid.c_str(),
                 mf.manifest_etag.c_str());
        return false;
    }
    if (!cache::WriteStateMeta(gid, mf.manifest_etag)) {
        ESP_LOGW(kTag, "State write failed, not switching group gid=%s etag=%s", gid.c_str(), mf.manifest_etag.c_str());
        return false;
    }
    SetCurrentGroupLocked(gid);
    group_changed = true;
    // 真有内容变化(新增/修改/删除帧),让 FrameScene 重读当前帧并触发 EPD 刷新。
    PostSyncedGroupReady(gid, mf.group_name, static_cast<int>(mf.contents.size()),
                         /*content_changed=*/true);
    return true;
}

bool SyncService::SyncCurrentContent(const std::string& gid, const api::ContentMeta& f, bool& changed) {
    changed = false;
    if (gid.empty() || f.id.empty() || f.seq < 0 || f.image_etag.empty())
        return false;

    cache::FrameMeta old_meta;
    cache::ReadFrameMeta(gid, f.seq, old_meta);
    cache::FrameMeta next_meta;
    next_meta.status_bar_text = f.device_status_bar_text;
    next_meta.content_etag    = f.content_etag;
    next_meta.has_ttl         = f.has_next_wake_sec && f.next_wake_sec >= 0;
    next_meta.ttl_sec         = f.next_wake_sec > 0 ? static_cast<uint32_t>(f.next_wake_sec) : 0;

    if (!f.content_etag.empty() && old_meta.content_etag == f.content_etag &&
        cache::FrameImageExists(gid, f.seq, f.image_etag) &&
        (f.audio_etag.empty() || cache::FrameAudioExists(gid, f.seq, f.audio_etag))) {
        if (old_meta.status_bar_text != next_meta.status_bar_text || old_meta.has_ttl != next_meta.has_ttl ||
            old_meta.ttl_sec != next_meta.ttl_sec) {
            if (!cache::WriteFrameMeta(gid, f.seq, next_meta)) {
                ESP_LOGW(kTag, "Frame %d meta write failed", f.seq);
                return false;
            }
        }
        UpdateCurrentFrameScheduleFromMeta(f.seq, next_meta);
        return true;
    }

    if (!cache::FrameImageExists(gid, f.seq, f.image_etag)) {
        std::vector<uint8_t> buf;
        bool                 nm = false;
        if (api::DownloadContentImage(f.id, "", buf, nm)) {
            if (!cache::WriteFrameImage(gid, f.seq, buf, f.image_etag)) {
                ESP_LOGW(kTag, "Frame %d image write failed", f.seq);
                return false;
            }
            changed = true;
        } else {
            return false;
        }
    }
    if (f.audio_etag.empty()) {
        cache::DeleteFrameAudio(gid, f.seq);
    } else if (!cache::FrameAudioExists(gid, f.seq, f.audio_etag)) {
        std::vector<uint8_t> buf;
        bool                 nm = false;
        if (api::DownloadContentAudio(f.id, "", buf, nm)) {
            if (cache::WriteFrameAudio(gid, f.seq, buf, f.audio_etag)) {
                changed = true;
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
    UpdateCurrentFrameScheduleFromMeta(f.seq, next_meta);
    changed = changed || old_meta.content_etag != f.content_etag;
    return true;
}

void SyncService::SyncOnce(SyncMode mode) {
    if (mode == SyncMode::kBackgroundRefresh) {
        if (deps_.current_group)
            SetCurrentGroupLocked(deps_.current_group());
    }
    // Poll 是设备接收远程状态变更的保活通道，不能按本地按键活跃度节流。
    // UI 刷新频率由 epd_display_mode 决定，不在这里控制。

    {
        UiEvent e{};
        e.kind = UiEventKind::kSyncStarted;
        evt::Post(e, 0);
    }

    api::Telemetry tel = BuildTelemetry(deps_, GetCurrentGroupLocked());

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        ESP_LOGW(kTag, "Poll failed (offline?)");
        UiEvent e{};
        e.kind                 = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }
    sntp::ApplyServerTime(state.server_time);
    // 1. bound 翻转:发独立事件让 splash / frame_scene 都能响应。
    const BoundState prev_bound = was_bound_.load();
    const BoundState next_bound = state.bound ? BoundState::kBound : BoundState::kUnbound;
    if (next_bound != prev_bound) {
        UiEvent e{};
        if (state.bound) {
            e.kind = UiEventKind::kBound;
            ESP_LOGI(kTag, "Bound");
        } else {
            e.kind = UiEventKind::kUnbound;
            std::strncpy(e.u.unbound.pair_code, state.pair_code.c_str(), sizeof(e.u.unbound.pair_code) - 1);
            e.u.unbound.pair_code[sizeof(e.u.unbound.pair_code) - 1] = '\0';
            ESP_LOGW(kTag, "Unbound: pair_code=%s", state.pair_code.c_str());
        }
        evt::Post(e, 0);
        was_bound_.store(next_bound);
        if (state.bound) {
            unbound_since_ms_.store(0);
        } else {
            unbound_since_ms_.store(esp_timer_get_time() / 1000);
        }
    }

    // 2. 当前态推 splash:让重启场景的 splash 也能直接拿到正确文案,无需依赖翻转。
    //    (启动时 splash 会先看 kAwaitingPair/kAwaitingGroup 切到正确文案;
    //     SyncManifestAndFrames 后续 emit kSyncedGroupReady 会 RequestReplace 到 FrameScene。)
    UiEvent stage_evt{};
    stage_evt.kind                      = UiEventKind::kBootStage;
    stage_evt.u.boot_stage.ssid[0]      = '\0';
    stage_evt.u.boot_stage.pair_code[0] = '\0';
    if (!state.bound) {
        stage_evt.u.boot_stage.stage = BootStage::kAwaitingPair;
        std::strncpy(stage_evt.u.boot_stage.pair_code, state.pair_code.c_str(),
                     sizeof(stage_evt.u.boot_stage.pair_code) - 1);
        evt::Post(stage_evt, 0);
    } else if (!state.has_group) {
        stage_evt.u.boot_stage.stage = BootStage::kAwaitingGroup;
        evt::Post(stage_evt, 0);
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
            ESP_LOGI(kTag, "Timer wake current_content but manifest stale; full sync");
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, group_changed);
        } else {
            sync_ok = SyncCurrentContent(state.group_id, state.current_content, group_changed);
            if (sync_ok && group_changed) {
                PostSyncedGroupReady(state.group_id, state.group_name, state.content_count,
                                     /*content_changed=*/true);
            }
        }
    } else if (mode == SyncMode::kBackgroundRefresh && state.has_group) {
        if (tel.manifest_etag != state.manifest_etag) {
            ESP_LOGI(kTag, "Timer wake manifest mismatch; full sync");
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, group_changed);
        } else {
            ESP_LOGI(kTag, "Timer wake has no current_content and manifest unchanged; skip sync");
        }
    } else if (mode == SyncMode::kBackgroundRefresh) {
        ESP_LOGI(kTag, "Timer wake has no group; clear cached current group");
        ClearCurrentGroupLocked();
        power_state::SetCurrentFrameSchedule({});
        sync_ok = cache::WriteStateMeta("", "");
    } else if (state.has_group) {
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, group_changed);
    } else {
        // 没选组:清掉 current_group_(scene 等下一次 ready 事件)
        ClearCurrentGroupLocked();
        sync_ok = cache::WriteStateMeta("", "");
    }

    UiEvent e{};
    e.kind                 = UiEventKind::kSyncFinished;
    e.u.sync.ok            = sync_ok;
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
        e.kind                 = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }

    bool group_changed = false;
    bool sync_ok       = true;
    if (state.has_group) {
        ESP_LOGI(kTag, "Cycled %s -> %s (pos %d/%d)", direction.c_str(), state.group_id.c_str(), state.position_current,
                 state.position_total);
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, group_changed);
    } else {
        ESP_LOGI(kTag, "Cycle %s: no groups available", direction.c_str());
        ClearCurrentGroupLocked();
        sync_ok = cache::WriteStateMeta("", "");
    }

    UiEvent e{};
    e.kind                 = UiEventKind::kSyncFinished;
    e.u.sync.ok            = sync_ok;
    e.u.sync.group_changed = group_changed;
    evt::Post(e, 0);
}

void SyncService::Loop() {
    while (running_.load()) {
        const int         interval_s = NextIntervalSec();
        const EventBits_t bits       = xEventGroupWaitBits(
            event_group_, BIT_TRIGGER | BIT_STOP | BIT_CYCLE_NEXT | BIT_CYCLE_PREV | BIT_WAKE_REFRESH, pdTRUE, pdFALSE,
            pdMS_TO_TICKS(interval_s * 1000));
        if (bits & BIT_STOP)
            break;
        if (!running_.load())
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
