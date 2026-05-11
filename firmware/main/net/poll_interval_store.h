#pragma once

// 轮询周期持久化: NVS namespace "slate", key "poll_sec"。

namespace poll {

constexpr int kDefault = 60;
constexpr int kMin     = 30;
constexpr int kMax     = 3600;

int  Get();             // 返回秒数, 首次读返回 kDefault
void Set(int seconds);  // clamp 到 [kMin, kMax] 后写 NVS

}  // namespace poll
