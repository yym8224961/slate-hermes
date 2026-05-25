#include "power_state.h"

#include <esp_attr.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>

#include <cstring>

namespace power_state {
namespace {

constexpr char kTag[] = "PowerState";

// 最小 wake 间隔：太短会把 deep sleep 的省电优势磨没。
constexpr uint32_t kMinWakeIntervalSec = 60u;

// RTC slow memory 持久化变量。深睡跨越保留。
// 注意：这些变量在 cold boot 第一次启动时是 0（BSS-like 行为）。
//
RTC_DATA_ATTR bool     s_frame_dynamic = false;
RTC_DATA_ATTR uint32_t s_frame_server_sync_sec = 0;
RTC_DATA_ATTR int      s_current_frame_seq = 0;

constexpr uint32_t kStatusBarSnapshotMagic = 0x53544231u;  // "STB1"
RTC_DATA_ATTR uint32_t s_status_bar_magic = 0;
RTC_DATA_ATTR uint32_t s_status_bar_hash = 0;
RTC_DATA_ATTR uint8_t  s_status_bar_snapshot[kStatusBarSnapshotBytes] = {};

portMUX_TYPE           s_state_mux = portMUX_INITIALIZER_UNLOCKED;

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

CurrentFrameSchedule GetCurrentFrameSchedule() {
    CurrentFrameSchedule schedule;
    portENTER_CRITICAL(&s_state_mux);
    schedule.dynamic = s_frame_dynamic;
    schedule.server_sync_sec = s_frame_server_sync_sec;
    portEXIT_CRITICAL(&s_state_mux);
    return schedule;
}

void SetCurrentFrameSchedule(const CurrentFrameSchedule& schedule) {
    portENTER_CRITICAL(&s_state_mux);
    s_frame_dynamic = schedule.dynamic;
    s_frame_server_sync_sec = schedule.dynamic ? NormalizeDynamicWakeSec(schedule.server_sync_sec) : 0;
    portEXIT_CRITICAL(&s_state_mux);
}

int GetCurrentFrameSeq() {
    portENTER_CRITICAL(&s_state_mux);
    const int seq = s_current_frame_seq;
    portEXIT_CRITICAL(&s_state_mux);
    return seq < 0 ? 0 : seq;
}

void SetCurrentFrameSeq(int seq) {
    portENTER_CRITICAL(&s_state_mux);
    s_current_frame_seq = seq < 0 ? 0 : seq;
    portEXIT_CRITICAL(&s_state_mux);
}

bool CurrentFrameNeedsTimerWake() {
    portENTER_CRITICAL(&s_state_mux);
    const bool needs_wake = s_frame_dynamic && s_frame_server_sync_sec > 0;
    portEXIT_CRITICAL(&s_state_mux);
    return needs_wake;
}

uint32_t ComputeNextWakeSec() {
    portENTER_CRITICAL(&s_state_mux);
    const bool dynamic = s_frame_dynamic;
    const uint32_t server_sync_sec = s_frame_server_sync_sec;
    portEXIT_CRITICAL(&s_state_mux);

    if (!dynamic) {
        ESP_LOGI(kTag, "Current frame has no dynamic wake interval");
        return 0;
    }
    const uint32_t next = NormalizeDynamicWakeSec(server_sync_sec);
    ESP_LOGI(kTag, "Next wake in %us (server_sync=%us)",
             static_cast<unsigned>(next),
             static_cast<unsigned>(server_sync_sec));
    return next;
}

bool SaveStatusBarSnapshot(const uint8_t* data, size_t len) {
    if (!data || len != kStatusBarSnapshotBytes)
        return false;
    const uint32_t hash = HashBytes(data, len);
    portENTER_CRITICAL(&s_state_mux);
    s_status_bar_magic = 0;
    std::memcpy(s_status_bar_snapshot, data, kStatusBarSnapshotBytes);
    s_status_bar_hash  = hash;
    s_status_bar_magic = kStatusBarSnapshotMagic;
    portEXIT_CRITICAL(&s_state_mux);
    ESP_LOGD(kTag, "Saved status bar snapshot hash=%08lx", static_cast<unsigned long>(hash));
    return true;
}

bool LoadStatusBarSnapshot(uint8_t* out, size_t len) {
    if (!out || len != kStatusBarSnapshotBytes)
        return false;
    uint32_t magic = 0;
    uint32_t hash  = 0;
    portENTER_CRITICAL(&s_state_mux);
    magic = s_status_bar_magic;
    hash  = s_status_bar_hash;
    if (magic == kStatusBarSnapshotMagic) {
        std::memcpy(out, s_status_bar_snapshot, kStatusBarSnapshotBytes);
    }
    portEXIT_CRITICAL(&s_state_mux);
    if (magic != kStatusBarSnapshotMagic)
        return false;
    return HashBytes(out, len) == hash;
}

void ClearStatusBarSnapshot() {
    portENTER_CRITICAL(&s_state_mux);
    s_status_bar_magic = 0;
    s_status_bar_hash  = 0;
    portEXIT_CRITICAL(&s_state_mux);
}

}  // namespace power_state
