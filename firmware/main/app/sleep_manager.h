#pragma once

// 闲置自动深睡。Tick() 检测闲置时长 ≥ 阈值 + 不在充电 + 启用状态时,
// 直接 esp_deep_sleep_start。醒来由 ext1 wakeup(GPIO 0/18 任一拉低)或重启触发,
// app_main 重新跑。
//
// 硬件限制:ESP32-S3 RTC GPIO 范围 0-21,GPIO 39(UP 键)不是 RTC IO,不能 ext1 唤醒。
// 只能 BOOT(GPIO0) / DOWN(GPIO18) 醒来。用户想看上一帧需要先按 DOWN/BOOT 醒,
// 再按 UP 翻。

#include <atomic>
#include <cstdint>
#include <functional>

struct UiEvent;

class SleepManager {
   public:
    using PreSleepHook = std::function<void()>;

    void Init(int idle_timeout_min);
    void Disable();  // captive portal 等场景禁用 deep sleep

    // 进睡前最后一刻调用,App 在这里 dispatch wifi 断开事件让状态栏更新,
    // 然后 EnterDeepSleep 内部立刻 RequestUrgentFullRefresh 把「诚实」画面留在屏上。
    void SetPreSleepHook(PreSleepHook hook) {
        pre_sleep_hook_ = std::move(hook);
    }

    void OnEvent(const UiEvent& e);
    void Tick(int64_t now_ms);

    // 主动进 deep sleep。不返回。
    void EnterDeepSleep();

   private:
    std::atomic<bool>    enabled_{false};
    std::atomic<int64_t> last_active_ms_{0};
    std::atomic<bool>    paused_{false};
    int                  idle_timeout_min_ = 5;
    PreSleepHook         pre_sleep_hook_;
};
