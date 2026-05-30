#pragma once

// 全局 UI 事件总线。所有事件源（按键、充电状态、WiFi、SyncService、TimeTick）
// Post 进来，唯一一个 ui_loop task 用 Wait 串行消费。
//
// 设计决策：
//   - FreeRTOS xQueue 长度 64，元素是 trivially-copyable 的 UiEvent。
//   - 不在 UiEvent 里塞 std::string / std::vector：Queue 是 byte-copy，
//     带 heap 句柄的对象进 queue = use-after-free。group.gid 是定长 char[32]。
//   - 满了 timeout 后丢新事件（不丢老的），打 ESP_LOGW，让开发者发现 ui_loop 卡住。

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <type_traits>

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

enum class ButtonId : uint8_t { kEnter = 0, kUp, kDown };

enum class GroupSyncStatusMode : uint8_t {
    kSwitchTarget = 0,    // 已拿到切换目标，用 name 显示“切到《name》”
    kSwitchCached,        // 目标内容组缓存命中
    kSwitchDownload,      // 正在下载切换目标内容组
    kCurrentUpdate,       // 正在更新当前内容组
    kStartupDownload,     // 启动/普通同步下载
    kSavingGroup,         // 下载后正在保存目标内容组缓存
    kSavingCurrentGroup,  // 下载后正在保存当前内容组缓存
    kSwitchFailed,        // 主动切换失败，保留当前内容组
};

// boot 阶段枚举;splash 用此切文案。顺序对应 splash 状态机典型路径。
enum class BootStage : uint8_t {
    kInitializing = 0,
    kProvisioning,       // 无 cred,captive portal 模式
    kWifiConnecting,     // 试连 STA(载荷带 ssid)
    kWifiFailed,         // 试连超时/认证失败
    kSntp,               // 等系统时间对齐
    kRegistering,        // 调 /devices
    kServerUnreachable,  // 服务器 30s 无响应
    kAwaitingPair,       // 注册完毕,等待 Web 端 claim(载荷带 pair_code)
    kAwaitingGroup,      // 已 bound,等待管理端分配内容组
    kNetError,           // 其它网络异常
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

namespace evt {

void Init();
bool Post(const UiEvent& e, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostFromIsr(const UiEvent& e, BaseType_t* hpw);
bool Wait(UiEvent* out, TickType_t timeout);

bool PostSimple(UiEventKind kind, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostButton(UiEventKind kind, ButtonId btn, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostChargeChanged(uint8_t state, bool present, bool charging, bool full, bool no_battery,
                       TickType_t timeout = pdMS_TO_TICKS(100));
bool PostBatteryUpdated(int mv, int pct, TickType_t timeout = 0);
bool PostWifiState(bool connected, int rssi, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostBootStage(BootStage stage, const char* ssid = nullptr, const char* pair_code = nullptr,
                   TickType_t timeout = pdMS_TO_TICKS(100));
bool PostGroupReady(UiEventKind kind, const std::string& gid, const std::string& name, int content_count,
                    bool content_changed, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostGroupSyncStatus(GroupSyncStatusMode mode, const std::string& gid, const std::string& name, uint8_t current = 0,
                         uint8_t total = 0, TickType_t timeout = 0);
bool PostSyncProgress(uint8_t current, uint8_t total, TickType_t timeout = 0);
bool PostSyncStarted(TickType_t timeout = 0);
bool PostSyncFinished(bool ok, bool group_changed, TickType_t timeout = 0);
bool PostUnbound(const std::string& pair_code, TickType_t timeout = 0);
bool PostXiaozhiChannelClosed(uint32_t token, TickType_t timeout = pdMS_TO_TICKS(100));

}  // namespace evt
