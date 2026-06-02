#include "power/minute_boundary_ticker.h"

#include <esp_log.h>
#include <sys/time.h>
#include <ctime>

#include "events/event_bus.h"

namespace {
constexpr char kTag[] = "minute_boundary";

// 触发点落在边界之后一点点，避免因调度抖动在边界前几毫秒触发、读到上一分钟。
constexpr int64_t kBoundaryEpsilonMs = 50;
constexpr int64_t kMinuteMs          = 60'000;

// 距下一分钟边界的毫秒数（含 epsilon）。墙钟未同步时也能给出 ~60s 的稳定节拍。
int64_t MsToNextBoundary() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    const int64_t ms_into_min = (static_cast<int64_t>(tv.tv_sec) % 60) * 1000 + tv.tv_usec / 1000;
    int64_t       delay       = kMinuteMs - ms_into_min + kBoundaryEpsilonMs;
    if (delay <= kBoundaryEpsilonMs)
        delay += kMinuteMs;  // 已过/正好在边界，推到下一分钟
    return delay;
}
}  // namespace

MinuteBoundaryTicker::~MinuteBoundaryTicker() {
    Stop();
}

void MinuteBoundaryTicker::Start() {
    if (timer_)
        return;
    esp_timer_create_args_t args = {};
    args.callback                = &MinuteBoundaryTicker::TickCb;
    args.arg                     = this;
    args.dispatch_method         = ESP_TIMER_TASK;
    args.name                    = "minute_boundary";
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer_));
    ArmNextBoundary();
}

void MinuteBoundaryTicker::ArmNextBoundary() {
    if (!timer_)
        return;
    esp_timer_start_once(timer_, MsToNextBoundary() * 1000);
}

void MinuteBoundaryTicker::Stop() {
    if (!timer_)
        return;
    esp_err_t err = esp_timer_stop(timer_);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(kTag, "timer stop failed err=%s", esp_err_to_name(err));
    }
    esp_timer_delete(timer_);
    timer_ = nullptr;
}

void MinuteBoundaryTicker::TickCb(void* arg) {
    auto* self = static_cast<MinuteBoundaryTicker*>(arg);

    time_t now = time(nullptr);
    if (now >= 1577836800) {  // 2020-01-01 之后才视为 SNTP 已同步；之前不发 tick，只续 arm
        struct tm tm;
        localtime_r(&now, &tm);
        int last = self->last_minute_.load(std::memory_order_acquire);
        if (tm.tm_min != last && self->last_minute_.compare_exchange_strong(last, tm.tm_min, std::memory_order_acq_rel,
                                                                            std::memory_order_acquire)) {
            evt::PostSimple(UiEventKind::kMinuteTick, evt::kNoWait);
        }
    }
    // 续 arm 到下一分钟边界。SNTP 校时若发生在本拍之前，这里用新墙钟重新对齐。
    self->ArmNextBoundary();
}
