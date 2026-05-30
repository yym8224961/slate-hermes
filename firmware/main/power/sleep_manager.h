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
// 用户在 Web 端输码后屏切「等待内容组」。轮询间隔阶梯退避(10s→30s→60s),
// 窗口最长 2h,过期或低电量(<20%)后回退正常省电策略,避免耗光电池。

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>

struct UiEvent;

class SleepManager {
   public:
    enum class SleepOutcome {
        kSlept,
        kPausedByCharge,
        kDisabled,
        kUnboundGrace,
    };

    // unbound 状态保持禁睡的最长窗口。超过则即便仍 unbound 也允许 deep sleep。
    static constexpr int64_t kUnboundGraceMs = 2LL * 60 * 60 * 1000;
    // 电量低于此阈值时强制允许 deep sleep,无视 unbound 状态。
    static constexpr int kLowBatteryPct = 20;

    struct SleepDecision {
        SleepOutcome outcome;
        uint32_t     configured_next_wake_sec;
    };

    struct Policy {
        int     idle_timeout_min = 5;
        int64_t unbound_grace_ms = kUnboundGraceMs;
        int     low_battery_pct  = kLowBatteryPct;
        bool    disabled         = false;
    };

    void Init(Policy p);
    void SetSleepBlocker(std::function<bool()> blocks_sleep);
    void Disable();  // captive portal 等场景禁用 deep sleep

    void OnEvent(const UiEvent& e);
    void Tick(int64_t now_ms);

    // 主动进 deep sleep。**正常情况不返回**；若被 paused_(充电中)/enabled_=false 短路，
    // 会立刻 return,调用方应转入正常 active 模式(例如把 cache 中的内容组 push 成 FrameScene)。
    SleepDecision TryEnterDeepSleep();

   private:
    // 当前是否处于 unbound 加速窗口(unbound + 未超 2h + 电量充足)。
    bool     InUnboundGrace(int64_t now_ms) const;
    bool     MarkUnboundIfNeeded(int64_t now_ms);
    uint32_t ComputeConfiguredNextWakeSec() const;
    bool     BlocksSleep() const;

    std::atomic<bool>    enabled_{false};
    std::atomic<int64_t> last_active_ms_{0};
    std::atomic<bool>    paused_{false};
    int                  idle_timeout_min_ = 5;
    int64_t              unbound_grace_ms_ = kUnboundGraceMs;
    int                  low_battery_pct_  = kLowBatteryPct;

    struct UnboundState {
        bool    unbound     = false;
        int     battery_pct = 100;
        int64_t since_ms    = 0;
    };

    mutable std::mutex unbound_mutex_;
    UnboundState       unbound_state_;

    std::function<bool()> blocks_sleep_;
};
