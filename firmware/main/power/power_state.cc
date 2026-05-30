#include "power/power_state.h"

#include <esp_attr.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <cstring>

#include "drivers/display/framebuffer_ops.h"
#include "utils/scoped_mutex_lock.h"

namespace power_state {
namespace {

constexpr char kTag[] = "PowerState";

// 最小 wake 间隔：太短会把 deep sleep 的省电优势磨没。
constexpr uint32_t kMinWakeIntervalSec = 60u;

// RTC slow memory 持久化变量。深睡跨越保留；cold boot 由 Init(true) 显式清零。
RTC_DATA_ATTR bool     s_frame_dynamic         = false;
RTC_DATA_ATTR uint32_t s_frame_server_sync_sec = 0;
RTC_DATA_ATTR int      s_current_frame_seq     = 0;

constexpr uint32_t     kStatusBarSnapshotMagic                             = 0x53544231u;  // "STB1"
RTC_DATA_ATTR uint32_t s_status_bar_magic                                  = 0;
RTC_DATA_ATTR uint32_t s_status_bar_hash                                   = 0;
RTC_DATA_ATTR uint8_t  s_status_bar_snapshot[epd::kStatusBarSnapshotBytes] = {};

SemaphoreHandle_t StateMutex() {
    static StaticSemaphore_t s_mutex_buf;
    static SemaphoreHandle_t s_mutex = xSemaphoreCreateMutexStatic(&s_mutex_buf);
    return s_mutex;
}

uint32_t NormalizeDynamicWakeSec(uint32_t sec) {
    return sec < kMinWakeIntervalSec ? kMinWakeIntervalSec : sec;
}

uint32_t HashBytes(const uint8_t* data, size_t len) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < len; ++i) {
        h ^= data[i];
        h *= 16777619u;
    }
    return h;
}

}  // namespace

void Init(bool cold_boot) {
    if (!cold_boot)
        return;
    ScopedMutexLock lock(StateMutex());
    s_frame_dynamic         = false;
    s_frame_server_sync_sec = 0;
    s_current_frame_seq     = 0;
    s_status_bar_magic      = 0;
    s_status_bar_hash       = 0;
    std::memset(s_status_bar_snapshot, 0, sizeof(s_status_bar_snapshot));
}

CurrentFrameSchedule GetCurrentFrameSchedule() {
    CurrentFrameSchedule schedule;
    ScopedMutexLock      lock(StateMutex());
    schedule.dynamic         = s_frame_dynamic;
    schedule.server_sync_sec = s_frame_server_sync_sec;
    return schedule;
}

void SetCurrentFrameSchedule(const CurrentFrameSchedule& schedule) {
    ScopedMutexLock lock(StateMutex());
    s_frame_dynamic         = schedule.dynamic;
    s_frame_server_sync_sec = schedule.dynamic ? NormalizeDynamicWakeSec(schedule.server_sync_sec) : 0;
}

int GetCurrentFrameSeq() {
    ScopedMutexLock lock(StateMutex());
    const int       seq = s_current_frame_seq;
    return seq < 0 ? 0 : seq;
}

void SetCurrentFrameSeq(int seq) {
    ScopedMutexLock lock(StateMutex());
    s_current_frame_seq = seq < 0 ? 0 : seq;
}

void SetCurrentFrameFromMeta(int seq, const cache::FrameMeta& meta) {
    CurrentFrameSchedule schedule;
    schedule.dynamic         = meta.has_ttl;
    schedule.server_sync_sec = meta.ttl_sec;
    SetCurrentFrameSchedule(schedule);
    SetCurrentFrameSeq(seq);
    cache::WriteCurrentFrameSeq(seq);
}

void ClearCurrentFrame() {
    SetCurrentFrameSchedule({});
    SetCurrentFrameSeq(0);
    cache::WriteCurrentFrameSeq(0);
}

bool RestoreCurrentFrameScheduleFromCache() {
    std::string gid;
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ClearCurrentFrame();
        return false;
    }

    int content_count = 0;
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ClearCurrentFrame();
        return false;
    }

    int seq = 0;
    cache::ReadCurrentFrameSeq(seq);
    if (seq < 0 || seq >= content_count)
        seq = 0;

    cache::FrameMeta meta;
    if (!cache::ReadFrameMeta(gid, seq, meta)) {
        SetCurrentFrameSchedule({});
        SetCurrentFrameSeq(seq);
        return false;
    }

    SetCurrentFrameFromMeta(seq, meta);
    return true;
}

bool CurrentFrameNeedsTimerWake() {
    ScopedMutexLock lock(StateMutex());
    const bool      needs_wake = s_frame_dynamic && s_frame_server_sync_sec > 0;
    return needs_wake;
}

uint32_t ComputeNextWakeSec() {
    ScopedMutexLock lock(StateMutex());
    const bool      dynamic         = s_frame_dynamic;
    const uint32_t  server_sync_sec = s_frame_server_sync_sec;

    if (!dynamic) {
        return 0;
    }
    const uint32_t next = NormalizeDynamicWakeSec(server_sync_sec);
    return next;
}

bool SaveStatusBarSnapshot(const uint8_t* data, size_t len) {
    if (!data || len != epd::kStatusBarSnapshotBytes)
        return false;
    const uint32_t  hash = HashBytes(data, len);
    ScopedMutexLock lock(StateMutex());
    // magic 是提交标记:先清无效,写完 snapshot/hash 后再恢复,Load 只接受完整快照。
    s_status_bar_magic = 0;
    std::memcpy(s_status_bar_snapshot, data, epd::kStatusBarSnapshotBytes);
    s_status_bar_hash  = hash;
    s_status_bar_magic = kStatusBarSnapshotMagic;
    ESP_LOGD(kTag, "Saved status bar snapshot hash=%08lx", static_cast<unsigned long>(hash));
    return true;
}

bool LoadStatusBarSnapshot(uint8_t* out, size_t len) {
    if (!out || len != epd::kStatusBarSnapshotBytes)
        return false;
    uint32_t magic = 0;
    uint32_t hash  = 0;
    {
        ScopedMutexLock lock(StateMutex());
        magic = s_status_bar_magic;
        hash  = s_status_bar_hash;
        if (magic == kStatusBarSnapshotMagic) {
            std::memcpy(out, s_status_bar_snapshot, epd::kStatusBarSnapshotBytes);
        }
    }
    if (magic != kStatusBarSnapshotMagic)
        return false;
    return HashBytes(out, len) == hash;
}

void ClearStatusBarSnapshot() {
    ScopedMutexLock lock(StateMutex());
    s_status_bar_magic = 0;
    s_status_bar_hash  = 0;
}

}  // namespace power_state
