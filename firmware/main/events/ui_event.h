#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "events/boot_stage.h"
#include "events/group_sync_status.h"

enum class ButtonId : uint8_t { kEnter = 0, kUp, kDown };

namespace evt {
namespace limits {
inline constexpr size_t kGroupIdBytes         = 32;
inline constexpr size_t kGroupSyncNameBytes   = 48;
inline constexpr size_t kGroupNameBytes       = 64;
inline constexpr size_t kWifiSsidBytes        = 33;
inline constexpr size_t kPairCodeBytes        = 8;
inline constexpr int    kMaxGroupContentCount = 100;
}  // namespace limits
}  // namespace evt

enum class UiEventKind : uint8_t {
    kButtonShort,       // u.button.btn
    kButtonLong,        // u.button.btn
    kButtonDouble,      // u.button.btn
    kChargeChanged,     // u.charge
    kBatteryUpdated,    // u.battery
    kWifiStateChanged,  // u.wifi
    kSyncStarted,
    kSyncProgress,      // u.progress { current, total }  帧级下载进度
    kGroupSyncStatus,   // u.group_sync  内容组切换/下载/更新状态
    kSyncFinished,      // u.sync
    kCachedGroupReady,  // u.group
    kSyncedGroupReady,  // u.group
    kMinuteTick,
    kIdleTimeout,
    // 启动阶段进度,由 app.cc TryConnectAndSetup 各步 emit;splash 用 stage 切文案。
    kBootStage,  // u.boot_stage
    // 设备从 unbound 翻 bound:Web 端用户输入了配对码。splash 切「等待内容组」。
    kBound,
    // 设备从 bound 翻 unbound:Web 端主动解绑。任何场景需 RequestReplace 回 splash。
    kUnbound,  // u.unbound { pair_code[8] }
    // poll 收到 401:secret 失效,固件 self-reset 流(清 NVS secret + 重启)。
    kSecretInvalid,
    // RTC timer 唤醒后台刷新场景完成/放弃，App 可立即进入下一轮 deep sleep。
    kBgRefreshDone,
    // 小智子系统状态变化。Scene 收到后从 ChatService 读取最新快照。
    kXiaozhiChanged,
    // 小智网络/服务端主动关闭。App 收到后转交 ChatService 收束对应会话。
    kXiaozhiChannelClosed,  // u.xiaozhi_channel.token
};

struct UiEvent {
    UiEventKind kind;
    union U {
        struct {
            ButtonId btn;
        } button;
        struct {
            uint8_t state;  // ChargeStatus::State
            bool    present;
            bool    charging;
            bool    full;
            bool    no_battery;
        } charge;
        struct {
            int mv;
            int pct;
        } battery;
        struct {
            bool connected;
            int  rssi;
        } wifi;
        struct {
            bool ok;
            bool group_changed;
        } sync;
        struct {
            uint8_t current;
            uint8_t total;
        } progress;
        struct {
            char                gid[evt::limits::kGroupIdBytes];
            char                name[evt::limits::kGroupSyncNameBytes];
            GroupSyncStatusMode mode;
            uint8_t             current;
            uint8_t             total;
        } group_sync;
        struct {
            char gid[evt::limits::kGroupIdBytes];
            char name[evt::limits::kGroupNameBytes];  // 当前组名（UTF-8），用于状态栏 / boot splash 文案
            int  content_count;
            // true = 本轮 sync 真下载了新 frame(内容变化);false = fast-path/304,只是确认状态。
            // FrameScene 用它决定是否触发 EPD full refresh,避免 30s 心跳每轮都闪屏。
            bool content_changed;
        } group;
        struct {
            BootStage stage;
            char      ssid[evt::limits::kWifiSsidBytes];       // kWifiConnecting 时设 STA SSID
            char      pair_code[evt::limits::kPairCodeBytes];  // kAwaitingPair 时设 6 位 + nul
        } boot_stage;
        struct {
            char pair_code[evt::limits::kPairCodeBytes];
        } unbound;
        struct {
            uint32_t token;
        } xiaozhi_channel;
        U() {
        }
    } u;

    UiEvent() : kind(UiEventKind::kMinuteTick), u() {
    }
};

static_assert(std::is_trivially_copyable_v<UiEvent>, "UiEvent must stay byte-copyable for FreeRTOS queues");
static_assert(std::is_standard_layout_v<UiEvent>, "UiEvent must stay layout-stable for FreeRTOS queues");
static_assert(std::is_trivially_destructible_v<UiEvent>, "UiEvent must not own resources in FreeRTOS queues");
static_assert(sizeof(UiEvent) <= 128, "UiEvent queue item grew unexpectedly");
