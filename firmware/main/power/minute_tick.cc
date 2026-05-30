#include "power/minute_tick.h"

#include <esp_log.h>
#include <ctime>

#include "events/event_bus.h"

namespace {
constexpr char kTag[] = "MinuteTick";
}

MinuteTick::~MinuteTick() {
    Stop();
}

void MinuteTick::Start() {
    if (timer_)
        return;
    esp_timer_create_args_t args = {};
    args.callback                = &MinuteTick::TickCb;
    args.arg                     = this;
    args.dispatch_method         = ESP_TIMER_TASK;
    args.name                    = "minute_tick";
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer_));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer_, 1000 * 1000));  // 1s
}

void MinuteTick::Stop() {
    if (!timer_)
        return;
    esp_err_t err = esp_timer_stop(timer_);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(kTag, "esp_timer_stop failed: %s", esp_err_to_name(err));
    }
    esp_timer_delete(timer_);
    timer_ = nullptr;
}

void MinuteTick::TickCb(void* arg) {
    auto* self = static_cast<MinuteTick*>(arg);

    time_t now = time(nullptr);
    if (now < 1577836800)
        return;  // 2020-01-01 之前视为 SNTP 未同步，跳过

    struct tm tm;
    localtime_r(&now, &tm);
    int last = self->last_minute_.load(std::memory_order_acquire);
    if (tm.tm_min == last)
        return;
    if (!self->last_minute_.compare_exchange_strong(last, tm.tm_min, std::memory_order_acq_rel,
                                                    std::memory_order_acquire)) {
        return;
    }

    evt::PostSimple(UiEventKind::kMinuteTick, 0);
}
