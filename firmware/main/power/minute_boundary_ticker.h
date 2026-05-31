#pragma once

// 1s 软定时器，跨分钟时 evt::Post(kMinuteTick)。用 1s 采样是为了贴近真实分钟边界；
// 直接 60s 周期会在 SNTP 校时、唤醒恢复或调时后漂移到分钟中间。

#include <esp_timer.h>

#include <atomic>

class MinuteBoundaryTicker {
   public:
    ~MinuteBoundaryTicker();

    void Start();
    void Stop();

   private:
    static void TickCb(void* arg);

    esp_timer_handle_t timer_ = nullptr;
    std::atomic<int>   last_minute_{-1};
};
