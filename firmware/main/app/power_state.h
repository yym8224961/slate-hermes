#pragma once

// RTC slow memory 持久化的电源状态。深睡跨越保留，掉电后清零。
//
// 用途：
//   - 记录当前帧是否有服务端下发的动态刷新间隔
//   - 避免每次 wake 都走完整 onboarding（cold boot 时数值为 0，按默认策略）
//
// 选 RTC slow RAM 而不是 NVS 的原因：写次数高（每次睡都更新）、不耐 flash 寿命。

#include <cstdint>

namespace power_state {

// 设备唤醒原因分类（基于 esp_sleep_get_wakeup_cause()）。
enum class WakeCause : uint8_t {
    kColdBoot = 0,  // 上电 / 软重启（POWERON / SW_RESET / 其它 RTC_SW_CPU_RESET）
    kButton,        // EXT1 按键唤醒（BOOT / DOWN）
    kCharge,        // EXT1 充电插入（CHARGE_DETECT 拉低）
    kRtcTimer,      // RTC timer 到期（动态帧 next_wake_sec 或静态兜底）
    kOther,         // 其他原因（UART / ULP / TouchPad），当前固件不用
};

// 解析本次启动的 wake 原因。仅看一次，结果应缓存。
WakeCause Classify();

struct CurrentFrameSchedule {
    bool     dynamic         = false;
    uint32_t server_sync_sec = 0;
};

// 当前展示帧的刷新策略。FrameScene::LoadFrame 调用 Set 写入，sleep_manager 在
// EnterDeepSleep 时用动态间隔优先；静态帧由 sleep_manager 使用低频兜底。
CurrentFrameSchedule GetCurrentFrameSchedule();
void                 SetCurrentFrameSchedule(const CurrentFrameSchedule& schedule);

int  GetCurrentFrameSeq();
void SetCurrentFrameSeq(int seq);
bool CurrentFrameNeedsTimerWake();

// 当前动态帧的下次 RTC timer wakeup 间隔（秒）。0 表示当前帧没有动态刷新间隔，
// 调用方可选择使用静态兜底。
uint32_t ComputeNextWakeSec();

}  // namespace power_state
