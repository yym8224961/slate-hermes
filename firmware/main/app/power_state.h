#pragma once

// RTC slow memory 持久化的电源状态。深睡跨越保留，掉电后清零。
//
// 用途：
//   - 计算下一次 RTC timer wakeup 间隔（per-frame TTL + 每日 telemetry）
//   - 避免每次 wake 都走完整 onboarding（cold boot 时数值为 0，按默认策略）
//
// 选 RTC slow RAM 而不是 NVS 的原因：写次数高（每次睡都更新）、不耐 flash 寿命。

#include <cstdint>

namespace power_state {

// 设备唤醒原因分类（基于 esp_sleep_get_wakeup_cause()）。
enum class WakeCause : uint8_t {
    kColdBoot = 0,   // 上电 / 软重启（POWERON / SW_RESET / 其它 RTC_SW_CPU_RESET）
    kButton,         // EXT1 按键唤醒（BOOT / DOWN）
    kCharge,         // EXT1 充电插入（CHARGE_DETECT 拉低）——目前 Classify() 不区分，
                     // 返回 kButton；调用方应自行读 charge 传感器确认。保留供未来细化。
    kRtcTimer,       // RTC timer 到期（widget TTL 或每日 telemetry）
    kOther,          // 其他原因（UART / ULP / TouchPad），当前固件不用
};

// 解析本次启动的 wake 原因。仅看一次，结果应缓存。
WakeCause Classify();

// 当前展示帧的下次刷新周期（秒）。0 = 静态帧 / 未知。FrameScene::LoadFrame
// 调用 Set 写入，sleep_manager.cc 在 EnterDeepSleep 时读。
uint32_t  GetCurrentFrameTtlSec();
void      SetCurrentFrameTtlSec(uint32_t sec);

// 上次成功 telemetry 上报的 monotonic 时间戳（秒，自上次 cold boot 起算）。
// SyncService 每次发完 telemetry 调 Update，sleep_manager 读出来算下次该 wake 的间隔。
// 0 表示从未上报或刚 cold boot。
uint32_t  GetLastTelemetryAt();
void      SetLastTelemetryAt(uint32_t epoch_or_seconds);

// 距离下次需要 telemetry 还有多少秒（>= 0）。
// telemetry 间隔由 CONFIG_SLATE_TELEMETRY_INTERVAL_H 控制（小时）。
uint32_t  SecsUntilNextTelemetry();

// 综合算出下次 RTC timer wakeup 间隔（秒）：
//   min(当前帧 TTL, telemetry 剩余时间, 上限)，至少 60s（避免抖动）。
// 当前实现始终返回 > 0（telemetry 候选兜底保证）；0 仅作理论保留路径（调用方不开 timer）。
uint32_t  ComputeNextWakeSec();

}  // namespace power_state
