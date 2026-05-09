#pragma once

// 1s 软定时器，跨分钟时 evt::Post(MinuteTick)。给状态栏分钟边界刷新用。
// 阶段 1 状态栏不显示时间，但保留这个事件，给阶段 2 设置页里的时间显示用。

#include <esp_timer.h>

class TimeTick {
   public:
    void Start();
    void Stop();

   private:
    static void TickCb(void* arg);

    esp_timer_handle_t timer_      = nullptr;
    int                last_minute_ = -1;
};
