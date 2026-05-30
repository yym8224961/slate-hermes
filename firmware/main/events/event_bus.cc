#include "events/event_bus.h"

#include <esp_log.h>

#include <algorithm>
#include <cstring>
#include <string>

#include "utils/utf8_utils.h"

namespace {
constexpr char        kTag[]    = "Event";
QueueHandle_t         s_queue   = nullptr;
constexpr UBaseType_t kQueueLen = 64;

void CopyEventText(char* out, size_t cap, const std::string& value) {
    util::CopyUtf8Truncated(out, cap, value);
}

void CopyEventText(char* out, size_t cap, const char* value) {
    util::CopyUtf8Truncated(out, cap, value ? std::string(value) : std::string());
}

int ClampContentCount(int content_count) {
    const int clamped = std::clamp(content_count, 0, evt::limits::kMaxGroupContentCount);
    if (clamped != content_count) {
        ESP_LOGW(kTag, "content_count clamped: %d -> %d", content_count, clamped);
    }
    return clamped;
}
}  // namespace

namespace evt {

void Init() {
    if (s_queue)
        return;
    s_queue = xQueueCreate(kQueueLen, sizeof(UiEvent));
    configASSERT(s_queue);
}

bool Post(const UiEvent& e, TickType_t timeout) {
    if (!s_queue) {
        ESP_LOGW(kTag, "Post before Init, dropped kind=%d", static_cast<int>(e.kind));
        return false;
    }
    if (xQueueSendToBack(s_queue, &e, timeout) != pdTRUE) {
        ESP_LOGW(kTag, "Queue full, dropped kind=%d", static_cast<int>(e.kind));
        return false;
    }
    return true;
}

bool PostFromIsr(const UiEvent& e, BaseType_t* hpw) {
    if (!s_queue)
        return false;
    return xQueueSendToBackFromISR(s_queue, &e, hpw) == pdTRUE;
}

bool Wait(UiEvent* out, TickType_t timeout) {
    if (!s_queue || !out)
        return false;
    return xQueueReceive(s_queue, out, timeout) == pdTRUE;
}

bool PostSimple(UiEventKind kind, TickType_t timeout) {
    UiEvent e{};
    e.kind = kind;
    return Post(e, timeout);
}

bool PostButton(UiEventKind kind, ButtonId btn, TickType_t timeout) {
    UiEvent e{};
    e.kind         = kind;
    e.u.button.btn = btn;
    return Post(e, timeout);
}

bool PostChargeChanged(uint8_t state, bool present, bool charging, bool full, bool no_battery, TickType_t timeout) {
    UiEvent e{};
    e.kind                = UiEventKind::kChargeChanged;
    e.u.charge.state      = state;
    e.u.charge.present    = present;
    e.u.charge.charging   = charging;
    e.u.charge.full       = full;
    e.u.charge.no_battery = no_battery;
    return Post(e, timeout);
}

bool PostBatteryUpdated(int mv, int pct, TickType_t timeout) {
    UiEvent e{};
    e.kind          = UiEventKind::kBatteryUpdated;
    e.u.battery.mv  = mv;
    e.u.battery.pct = pct;
    return Post(e, timeout);
}

bool PostWifiState(bool connected, int rssi, TickType_t timeout) {
    UiEvent e{};
    e.kind             = UiEventKind::kWifiStateChanged;
    e.u.wifi.connected = connected;
    e.u.wifi.rssi      = rssi;
    return Post(e, timeout);
}

bool PostBootStage(BootStage stage, const char* ssid, const char* pair_code, TickType_t timeout) {
    UiEvent e{};
    e.kind               = UiEventKind::kBootStage;
    e.u.boot_stage.stage = stage;
    CopyEventText(e.u.boot_stage.ssid, sizeof(e.u.boot_stage.ssid), ssid);
    CopyEventText(e.u.boot_stage.pair_code, sizeof(e.u.boot_stage.pair_code), pair_code);
    return Post(e, timeout);
}

bool PostGroupReady(UiEventKind kind, const std::string& gid, const std::string& name, int content_count,
                    bool content_changed, TickType_t timeout) {
    UiEvent e{};
    e.kind = kind;
    CopyEventText(e.u.group.gid, sizeof(e.u.group.gid), gid);
    CopyEventText(e.u.group.name, sizeof(e.u.group.name), name);
    e.u.group.content_count   = ClampContentCount(content_count);
    e.u.group.content_changed = content_changed;
    return Post(e, timeout);
}

bool PostGroupSyncStatus(GroupSyncStatusMode mode, const std::string& gid, const std::string& name, uint8_t current,
                         uint8_t total, TickType_t timeout) {
    UiEvent e{};
    e.kind = UiEventKind::kGroupSyncStatus;
    CopyEventText(e.u.group_sync.gid, sizeof(e.u.group_sync.gid), gid);
    CopyEventText(e.u.group_sync.name, sizeof(e.u.group_sync.name), name);
    e.u.group_sync.mode    = mode;
    e.u.group_sync.current = current;
    e.u.group_sync.total   = total;
    return Post(e, timeout);
}

bool PostSyncProgress(uint8_t current, uint8_t total, TickType_t timeout) {
    UiEvent e{};
    e.kind               = UiEventKind::kSyncProgress;
    e.u.progress.current = current;
    e.u.progress.total   = total;
    return Post(e, timeout);
}

bool PostSyncStarted(TickType_t timeout) {
    return PostSimple(UiEventKind::kSyncStarted, timeout);
}

bool PostSyncFinished(bool ok, bool group_changed, TickType_t timeout) {
    UiEvent e{};
    e.kind                 = UiEventKind::kSyncFinished;
    e.u.sync.ok            = ok;
    e.u.sync.group_changed = group_changed;
    return Post(e, timeout);
}

bool PostUnbound(const std::string& pair_code, TickType_t timeout) {
    UiEvent e{};
    e.kind = UiEventKind::kUnbound;
    CopyEventText(e.u.unbound.pair_code, sizeof(e.u.unbound.pair_code), pair_code);
    return Post(e, timeout);
}

bool PostXiaozhiChannelClosed(uint32_t token, TickType_t timeout) {
    UiEvent e{};
    e.kind                    = UiEventKind::kXiaozhiChannelClosed;
    e.u.xiaozhi_channel.token = token;
    return Post(e, timeout);
}

}  // namespace evt
