#pragma once

// 闲置自动深睡。Tick() 检测闲置时长 ≥ 阈值 + 不在充电 + 启用状态时,
// 直接 esp_deep_sleep_start。醒来由 ext1 wakeup(GPIO 0/18 任一拉低)或重启触发,
// app_main 重新跑。
//
// 硬件限制:ESP32-S3 RTC GPIO 范围 0-21,GPIO 39(UP 键)不是 RTC IO,不能 ext1 唤醒。
// 只能 BOOT(GPIO0) / DOWN(GPIO18) 醒来。用户想看上一帧需要先按 DOWN/BOOT 醒,
// 再按 UP 翻。
//
// Unbound grace 窗口:设备未绑定时禁 deep sleep,让 SyncService 快轮询,
// 用户在 Web 端输码后屏切「等待相册」。轮询间隔阶梯退避(10s→30s→60s),
// 窗口最长 2h,过期或低电量(<20%)后回退正常省电策略,避免耗光电池。

#include <atomic>
#include <cstdint>
#include <functional>
#include <utility>

struct UiEvent;

class SleepManager {
   public:
    using PreSleepHook = std::function<void()>;

    // unbound 状态保持禁睡的最长窗口。超过则即便仍 unbound 也允许 deep sleep。
    static constexpr int64_t kUnboundGraceMs = 2LL * 60 * 60 * 1000;
    // 电量低于此阈值时强制允许 deep sleep,无视 unbound 状态。
    static constexpr int kLowBatteryPct = 20;

    void Init(int idle_timeout_min);
    void Disable();  // captive portal 等场景禁用 deep sleep

    // 进睡前最后一刻调用。固定状态栏已移除，默认不需要为了状态图标刷新屏幕。
    void SetPreSleepHook(PreSleepHook hook) {
        pre_sleep_hook_ = std::move(hook);
    }

    void OnEvent(const UiEvent& e);
    void Tick(int64_t now_ms);

    // 主动进 deep sleep。不返回。
    void EnterDeepSleep();

   private:
    // 当前是否处于 unbound 加速窗口(unbound + 未超 2h + 电量充足)。
    bool InUnboundGrace(int64_t now_ms) const;

    std::atomic<bool>    enabled_{false};
    std::atomic<int64_t> last_active_ms_{0};
    std::atomic<bool>    paused_{false};
    int                  idle_timeout_min_ = 5;
    PreSleepHook         pre_sleep_hook_;

    // unbound 加速窗口状态:
    //   unbound_         = 是否处于 unbound 状态(默认 false,
    //                      首次 kUnbound 事件到达时翻 true,kBound 时翻回 false)。
    //   unbound_since_ms = 进入 unbound 的时刻(ms 单调时基),用于兜底超时。
    //   battery_pct_     = 最近一次 telemetry 上报的电量,< kLowBatteryPct 时退出加速。
    std::atomic<bool>    unbound_{false};
    std::atomic<int64_t> unbound_since_ms_{0};
    std::atomic<int>     battery_pct_{100};
};
