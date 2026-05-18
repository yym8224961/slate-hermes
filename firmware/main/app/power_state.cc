#include "power_state.h"

#include <esp_attr.h>
#include <esp_log.h>
#include <esp_sleep.h>
#include <freertos/FreeRTOS.h>

#include "config.h"

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
portMUX_TYPE           s_state_mux = portMUX_INITIALIZER_UNLOCKED;

uint32_t NormalizeDynamicWakeSec(uint32_t sec) {
    return sec < kMinWakeIntervalSec ? kMinWakeIntervalSec : sec;
}

}  // namespace

WakeCause Classify() {
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    switch (cause) {
        case ESP_SLEEP_WAKEUP_UNDEFINED:
            return WakeCause::kColdBoot;
        case ESP_SLEEP_WAKEUP_EXT1: {
            const uint64_t mask = esp_sleep_get_ext1_wakeup_status();
            if (mask & ((1ULL << BOOT_BUTTON_GPIO) | (1ULL << DOWN_BUTTON_GPIO))) {
                return WakeCause::kButton;
            }
            if (mask & (1ULL << CHARGE_DETECT_GPIO)) {
                return WakeCause::kCharge;
            }
            ESP_LOGW(kTag, "Unknown EXT1 wake mask=0x%llx -> other", (unsigned long long)mask);
            return WakeCause::kOther;
        }
        case ESP_SLEEP_WAKEUP_TIMER:
            return WakeCause::kRtcTimer;
        default:
            return WakeCause::kOther;
    }
}

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

}  // namespace power_state
