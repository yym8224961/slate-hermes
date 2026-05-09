#include "time_tick.h"

#include <ctime>
#include <esp_log.h>

#include "event_bus.h"

namespace {
constexpr char kTag[] = "tick";
}

void TimeTick::Start() {
    if (timer_) return;
    esp_timer_create_args_t args = {};
    args.callback                = &TimeTick::TickCb;
    args.arg                     = this;
    args.dispatch_method         = ESP_TIMER_TASK;
    args.name                    = "time_tick";
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer_));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer_, 1000 * 1000));  // 1s
    ESP_LOGI(kTag, "time tick started");
}

void TimeTick::Stop() {
    if (!timer_) return;
    esp_timer_stop(timer_);
    esp_timer_delete(timer_);
    timer_ = nullptr;
}

void TimeTick::TickCb(void* arg) {
    auto* self = static_cast<TimeTick*>(arg);

    time_t now = time(nullptr);
    if (now < 1577836800) return;  // 2020-01-01 之前视为 SNTP 未同步，跳过

    struct tm tm;
    localtime_r(&now, &tm);
    if (tm.tm_min == self->last_minute_) return;
    self->last_minute_ = tm.tm_min;

    UiEvent e{};
    e.kind = UiEventKind::kMinuteTick;
    evt::Post(e, 0);
}
