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
    kButtonShort,       // u.button.btn
    kButtonLong,        // u.button.btn
    kButtonDouble,      // u.button.btn
    kChargeChanged,     // u.charge
    kBatteryUpdated,    // u.battery
    kWifiStateChanged,  // u.wifi
    kSyncStarted,
    kSyncProgress,      // u.progress { current, total }  帧级下载进度
    kSyncFinished,      // u.sync
    kCachedGroupReady,  // u.group
    kSyncedGroupReady,  // u.group
    kMinuteTick,
    kIdleTimeout,
    // 启动阶段进度,由 app.cc TryConnectAndSetup 各步 emit;splash 用 stage 切文案。
    kBootStage,  // u.boot_stage
    // 设备从 unbound 翻 bound:Web 端用户输入了配对码。splash 切「等待相册」。
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
    kAwaitingGroup,      // 已 bound,等待管理端分配相册
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
            char gid[32];
            char name[64];  // 当前组名（UTF-8），用于状态栏 / boot splash 文案
            int  content_count;
            // true = 本轮 sync 真下载了新 frame(内容变化);false = fast-path/304,只是确认状态。
            // FrameScene 用它决定是否触发 EPD full refresh,避免 30s 心跳每轮都闪屏。
            bool content_changed;
        } group;
        struct {
            BootStage stage;
            char      ssid[33];      // kWifiConnecting 时设 STA SSID
            char      pair_code[8];  // kAwaitingPair 时设 6 位 + nul
        } boot_stage;
        struct {
            char pair_code[8];
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

namespace evt {

void Init();
bool Post(const UiEvent& e, TickType_t timeout = pdMS_TO_TICKS(100));
bool PostFromIsr(const UiEvent& e, BaseType_t* hpw);
bool Wait(UiEvent* out, TickType_t timeout);

}  // namespace evt
