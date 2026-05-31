#pragma once

// 跨分钟时 evt::Post(kMinuteTick)。单次定时器，每次对齐到「下一个分钟边界」再触发，
// 触发后重新计算并续 arm。相比旧的每秒轮询，空闲时 CPU 每分钟只被唤醒一次（其余
// 59 次省掉），让自动 light sleep 能睡满；对齐用墙钟，SNTP 校时后下一拍自动归位。

#include <esp_timer.h>

#include <atomic>

class MinuteBoundaryTicker {
   public:
    ~MinuteBoundaryTicker();

    void Start();
    void Stop();

   private:
    static void TickCb(void* arg);
    // 计算到下一分钟边界的延时并 arm 单次定时器（带小 epsilon 确保落在边界之后）。
    void ArmNextBoundary();

    esp_timer_handle_t timer_ = nullptr;
    std::atomic<int>   last_minute_{-1};
};
