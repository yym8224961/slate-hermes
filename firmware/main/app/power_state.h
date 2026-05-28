#pragma once

// RTC slow memory 持久化的电源状态。深睡跨越保留，掉电后清零。
//
// 用途：
//   - 记录当前帧是否有服务端下发的动态刷新间隔
//   - 避免每次 wake 都走完整 onboarding（cold boot 时数值为 0，按默认策略）
//
// 选 RTC slow RAM 而不是 NVS 的原因：写次数高（每次睡都更新）、不耐 flash 寿命。

#include <cstddef>
#include <cstdint>

#include "cache.h"

namespace power_state {

constexpr int kStatusBarSnapshotWidth  = 400;
constexpr int kStatusBarSnapshotHeight = 24;
constexpr int kStatusBarSnapshotBytes  = kStatusBarSnapshotWidth * kStatusBarSnapshotHeight / 8;

struct CurrentFrameSchedule {
    bool     dynamic         = false;
    uint32_t server_sync_sec = 0;
};

// 当前展示帧的刷新策略。FrameScene::LoadFrame 写入；RTC timer 唤醒后台同步当前
// 动态帧时,SyncService 也会更新这里的 next_wake_sec。静态帧不会自己变更,
// 不配置定时唤醒,避免为了无意义同步空耗电。
CurrentFrameSchedule GetCurrentFrameSchedule();
void                 SetCurrentFrameSchedule(const CurrentFrameSchedule& schedule);

int  GetCurrentFrameSeq();
void SetCurrentFrameSeq(int seq);
bool CurrentFrameNeedsTimerWake();
void SetCurrentFrameFromMeta(int seq, const cache::FrameMeta& meta);
void ClearCurrentFrame();

// 从 LittleFS cache 恢复当前帧序号和动态刷新策略。用于 deep sleep 前兜底，
// 防止 RTC slow memory 因 reset/cold boot 丢失后下一轮 timer wake 被关闭。
bool RestoreCurrentFrameScheduleFromCache();

// 当前动态帧的下次 RTC timer wakeup 间隔（秒）。0 表示当前帧没有动态刷新间隔。
uint32_t ComputeNextWakeSec();

// 睡前最后一次刷到物理屏上的状态栏 1bpp 快照。用于 timer wake 后重建
// prev_buffer_ 的 0~24 行，让后台 partial refresh 的 old/new 输入真实一致。
bool SaveStatusBarSnapshot(const uint8_t* data, size_t len);
bool LoadStatusBarSnapshot(uint8_t* out, size_t len);
void ClearStatusBarSnapshot();

}  // namespace power_state
