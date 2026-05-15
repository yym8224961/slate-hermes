#include "power_state.h"

#include <esp_attr.h>
#include <esp_log.h>
#include <esp_sleep.h>
#include <sdkconfig.h>
#include <time.h>

#include <algorithm>

namespace power_state {
namespace {

constexpr char kTag[] = "PowerState";

// telemetry 间隔（小时）。在 Kconfig.projbuild 里加 CONFIG_SLATE_TELEMETRY_INTERVAL_H=24。
#ifndef CONFIG_SLATE_TELEMETRY_INTERVAL_H
#define CONFIG_SLATE_TELEMETRY_INTERVAL_H 24
#endif
constexpr uint32_t kTelemetryIntervalSec = CONFIG_SLATE_TELEMETRY_INTERVAL_H * 3600u;

// 下次 wake 间隔的硬上限：兜底防止设备长期不上线。30 min。
constexpr uint32_t kMaxWakeIntervalSec = 30u * 60u;
// 最小 wake 间隔：太短会把 deep sleep 的省电优势磨没。
constexpr uint32_t kMinWakeIntervalSec = 60u;

// RTC slow memory 持久化变量。深睡跨越保留。
// 注意：这些变量在 cold boot 第一次启动时是 0（BSS-like 行为）。
//
// s_last_telemetry_at_sec 存 UNIX epoch（SNTP 同步后）：
//   - 跨 deep sleep 保留 → 醒后 time(NULL) 也是 UNIX epoch，直接相减
//   - 跨 cold boot 归零 → 触发立即上报一次
//   - SNTP 未同步时 time(NULL) 返回 epoch+uptime（很小），用 sentinel 检测
RTC_DATA_ATTR uint32_t s_current_frame_ttl_sec = 0;
RTC_DATA_ATTR uint32_t s_last_telemetry_at_sec = 0;

// 早于此时刻的 timestamp 视为 SNTP 未同步（2023-11-15 00:00 UTC）。
constexpr uint32_t kEpochValidThreshold = 1700000000u;

}  // namespace

WakeCause Classify() {
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    switch (cause) {
        case ESP_SLEEP_WAKEUP_UNDEFINED:
            return WakeCause::kColdBoot;
        case ESP_SLEEP_WAKEUP_EXT1: {
            // 判定按键 vs 充电插入：充电检测 GPIO 拉低也走 EXT1。
            // 具体哪个 GPIO 触发可调 esp_sleep_get_ext1_wakeup_status()，但当前
            // 实现层不区分 button/charge —— sleep_manager Tick 会读 charge 状态决定行为。
            // 简单起见：默认 kButton；上层据 charge state 决定要不要 disable sleep。
            return WakeCause::kButton;
        }
        case ESP_SLEEP_WAKEUP_TIMER:
            return WakeCause::kRtcTimer;
        default:
            return WakeCause::kOther;
    }
}

uint32_t GetCurrentFrameTtlSec() {
    return s_current_frame_ttl_sec;
}

void SetCurrentFrameTtlSec(uint32_t sec) {
    s_current_frame_ttl_sec = sec;
}

uint32_t GetLastTelemetryAt() {
    return s_last_telemetry_at_sec;
}

void SetLastTelemetryAt(uint32_t v) {
    // 拒绝明显无效的时间戳（SNTP 未同步时 time() 返回 epoch+uptime 几秒到几分钟）。
    // 否则下次 SecsUntilNextTelemetry() 会用错误基准算 elapsed。
    if (v < kEpochValidThreshold) {
        ESP_LOGW(kTag, "SetLastTelemetryAt rejected: %u (SNTP not synced?)", v);
        return;
    }
    s_last_telemetry_at_sec = v;
}

uint32_t SecsUntilNextTelemetry() {
    if (s_last_telemetry_at_sec == 0) {
        return 0;  // 从未上报 → 立即 wake 上报一次
    }
    const time_t now_t = time(nullptr);
    const uint32_t now = static_cast<uint32_t>(now_t);
    // SNTP 未同步 → 不能判断 elapsed，让设备醒后做一次 SNTP+poll 即可。
    if (now < kEpochValidThreshold) return 0;
    // s_last_telemetry_at_sec 应在 SNTP 同步后写入，所以 now >= last 几乎必然。
    // 例外：用户改系统时间倒退/掉电后 RTC 不连续 → 重置触发立即上报。
    if (now < s_last_telemetry_at_sec) {
        ESP_LOGW(kTag, "Clock went backward: now=%u last=%u, resetting",
                 now, s_last_telemetry_at_sec);
        s_last_telemetry_at_sec = 0;
        return 0;
    }
    const uint32_t elapsed = now - s_last_telemetry_at_sec;
    if (elapsed >= kTelemetryIntervalSec) return 0;
    return kTelemetryIntervalSec - elapsed;
}

uint32_t ComputeNextWakeSec() {
    uint32_t candidates[2];
    int n = 0;
    if (s_current_frame_ttl_sec > 0) candidates[n++] = s_current_frame_ttl_sec;
    candidates[n++] = SecsUntilNextTelemetry();

    // 取最小且 > 0 的候选；都为 0 表示"立即"→ 返回 60s 兜底。
    uint32_t next = kMaxWakeIntervalSec;
    bool any = false;
    for (int i = 0; i < n; ++i) {
        if (candidates[i] == 0) {
            // 立即 → 用最小间隔
            next = std::min(next, kMinWakeIntervalSec);
            any  = true;
            continue;
        }
        next = std::min(next, candidates[i]);
        any  = true;
    }
    if (!any) {
        // 理论上不可达：SecsUntilNextTelemetry() 总是被加入 candidates。
        // 保留分支以防未来删掉 telemetry 候选后的回归。
        ESP_LOGI(kTag, "No wake candidates -> rely on button only");
        return 0;
    }
    if (next < kMinWakeIntervalSec) next = kMinWakeIntervalSec;
    if (next > kMaxWakeIntervalSec) next = kMaxWakeIntervalSec;
    ESP_LOGI(kTag, "Next wake in %us (frame_ttl=%us, telemetry_due=%us)",
             static_cast<unsigned>(next),
             static_cast<unsigned>(s_current_frame_ttl_sec),
             static_cast<unsigned>(SecsUntilNextTelemetry()));
    return next;
}

}  // namespace power_state
