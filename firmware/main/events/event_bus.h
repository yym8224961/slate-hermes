#pragma once

// 全局 UI 事件总线。所有事件源（按键、充电状态、WiFi、SyncService、分钟边界 ticker）
// Post 进来，唯一一个 ui_loop task 用 Wait 串行消费。
//
// 设计决策：
//   - FreeRTOS xQueue 长度 64，元素是 trivially-copyable 的 UiEvent。
//   - 不在 UiEvent 里塞 std::string / std::vector：Queue 是 byte-copy，
//     带 heap 句柄的对象进 queue = use-after-free。group.gid 是定长 char[32]。
//   - 满了 timeout 后丢新事件（不丢老的），打 ESP_LOGW，让开发者发现 ui_loop 卡住。
//   - 默认事件允许短暂等待；同步进度/轮询状态类事件默认 no-wait，避免后台任务被 UI 队列反压卡住。

#include <freertos/FreeRTOS.h>

#include <cstdint>
#include <string>

#include "events/ui_event.h"

namespace evt {

inline constexpr TickType_t kDefaultPostTimeout = pdMS_TO_TICKS(100);
inline constexpr TickType_t kNoWait             = 0;

void Init();
bool Post(const UiEvent& e, TickType_t timeout = kDefaultPostTimeout);
bool PostFromIsr(const UiEvent& e, BaseType_t* hpw);
bool Wait(UiEvent* out, TickType_t timeout);

bool PostSimple(UiEventKind kind, TickType_t timeout = kDefaultPostTimeout);
bool PostButton(UiEventKind kind, ButtonId btn, TickType_t timeout = kDefaultPostTimeout);
bool PostChargeChanged(uint8_t state, bool present, bool charging, bool full, bool no_battery,
                       TickType_t timeout = kDefaultPostTimeout);
bool PostBatteryUpdated(int mv, int pct, TickType_t timeout = kNoWait);
bool PostWifiState(bool connected, int rssi, TickType_t timeout = kDefaultPostTimeout);
bool PostBootStage(BootStage stage, const char* ssid = nullptr, const char* pair_code = nullptr,
                   TickType_t timeout = kDefaultPostTimeout);
bool PostGroupReady(UiEventKind kind, const std::string& gid, const std::string& name, int content_count,
                    bool content_changed, TickType_t timeout = kDefaultPostTimeout);
bool PostGroupSyncStatus(GroupSyncStatusMode mode, const std::string& gid, const std::string& name, uint8_t current = 0,
                         uint8_t total = 0, TickType_t timeout = kNoWait);
bool PostSyncProgress(uint8_t current, uint8_t total, TickType_t timeout = kNoWait);
bool PostSyncStarted(TickType_t timeout = kNoWait);
bool PostSyncFinished(bool ok, bool group_changed, TickType_t timeout = kNoWait);
bool PostUnbound(const std::string& pair_code, TickType_t timeout = kNoWait);
bool PostXiaozhiChannelClosed(uint32_t token, TickType_t timeout = kDefaultPostTimeout);

}  // namespace evt
