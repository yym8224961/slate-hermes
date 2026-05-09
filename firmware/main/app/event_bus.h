#pragma once

// 全局 UI 事件总线。所有事件源（按键、充电状态、WiFi、SyncService、TimeTick）
// Post 进来，唯一一个 ui_loop task 用 Wait 串行消费。
//
// 设计决策：
//   - FreeRTOS xQueue 长度 32，元素是 trivially-copyable 的 UiEvent。
//   - 不在 UiEvent 里塞 std::string / std::vector：Queue 是 byte-copy，
//     带 heap 句柄的对象进 queue = use-after-free。group.gid 是定长 char[32]。
//   - 满了 timeout 后丢新事件（不丢老的），打 ESP_LOGW，让开发者发现 ui_loop 卡住。

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include <cstdint>

enum class UiEventKind : uint8_t {
    kButtonShort,        // u.button.btn
    kButtonLong,         // u.button.btn
    kChargeChanged,      // u.charge
    kBatteryUpdated,     // u.battery
    kWifiStateChanged,   // u.wifi
    kSyncStarted,
    kSyncProgress,       // u.progress { current, total }  帧级下载进度
    kSyncFinished,       // u.sync
    kGroupReady,         // u.group
    kMinuteTick,
    kIdleTimeout,
};

enum class ButtonId : uint8_t { kEnter = 0, kUp, kDown };

struct UiEvent {
    UiEventKind kind;
    union U {
        struct { ButtonId btn; }                          button;
        struct {
            uint8_t state;        // ChargeStatus::State
            bool    present;
            bool    charging;
            bool    full;
            bool    no_battery;
        }                                                  charge;
        struct { int mv; int pct; }                       battery;
        struct { bool connected; int rssi; }              wifi;
        struct { bool ok; bool group_changed; }           sync;
        struct { uint8_t current; uint8_t total; }        progress;
        struct {
            char gid[32];
            int  frame_count;
            int  default_idx;
        }                                                  group;
        U() {}
    } u;

    UiEvent() : kind(UiEventKind::kMinuteTick), u() {}
};

namespace evt {

void Init();
bool Post(const UiEvent& e, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostFromIsr(const UiEvent& e, BaseType_t* hpw);
bool Wait(UiEvent* out, TickType_t timeout);

}  // namespace evt
