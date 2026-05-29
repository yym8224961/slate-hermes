#include "wifi.h"

#include <esp_log.h>
#include <esp_mac.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <lwip/inet.h>
#include <nvs_flash.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <utility>

namespace {
constexpr char kTag[] = "Wifi";

EventGroupHandle_t s_event_group = nullptr;
constexpr int      BIT_CONNECTED = BIT0;
constexpr int      BIT_FAIL      = BIT1;

// 慢速重连指数退避序列(秒)。fast retry 5 次用完后,从 idx=0 开始排队 scan,
// 每次失败 idx++ 直到上限(120s)。IP_GOT_IP 后回 0。
constexpr uint32_t kBackoffSec[]       = {10, 20, 40, 80, 120, 120};
constexpr size_t   kBackoffSize        = sizeof(kBackoffSec) / sizeof(kBackoffSec[0]);
constexpr uint16_t kMaxSlowScanRecords = 20;

size_t BoundedSsidLen(const uint8_t ssid[32]) {
    size_t len = 0;
    while (len < 32 && ssid[len] != 0)
        ++len;
    return len;
}

bool SsidEquals(const uint8_t lhs[32], const uint8_t rhs[32]) {
    const size_t lhs_len = BoundedSsidLen(lhs);
    const size_t rhs_len = BoundedSsidLen(rhs);
    return lhs_len == rhs_len && std::memcmp(lhs, rhs, lhs_len) == 0;
}

bool FillStaConfig(wifi_config_t& wc, const std::string& ssid, const std::string& password, std::string* reason) {
    wc = {};
    if (ssid.empty()) {
        if (reason)
            *reason = "SSID 不能为空";
        return false;
    }
    if (ssid.size() > sizeof(wc.sta.ssid)) {
        if (reason)
            *reason = "SSID 过长";
        return false;
    }
    if (password.size() >= sizeof(wc.sta.password)) {
        if (reason)
            *reason = "Wi-Fi 密码过长";
        return false;
    }
    std::memcpy(wc.sta.ssid, ssid.data(), ssid.size());
    std::memcpy(wc.sta.password, password.data(), password.size());
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable    = true;
    wc.sta.pmf_cfg.required   = false;
    return true;
}
}  // namespace

// 前向声明,EventHandler 在文件靠前位置就要打它,实际函数体在 TryConnect 旁边。
static std::string DisconnectReasonZh(int reason);

Wifi& Wifi::Get() {
    static Wifi w;
    return w;
}

void Wifi::EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data) {
    Wifi* self = static_cast<Wifi*>(arg);

    if (base == WIFI_EVENT) {
        // 注意:WIFI_EVENT_STA_START 不在这里 esp_wifi_connect。Connect/TryConnect
        // 走显式触发,因为 set_config 在 start 之后执行。
        if (id == WIFI_EVENT_STA_DISCONNECTED) {
            auto*      d              = static_cast<wifi_event_sta_disconnected_t*>(data);
            const bool want_reconnect = self->want_reconnect_.load(std::memory_order_acquire);
            const int  fail_count     = self->fail_count_.load(std::memory_order_acquire);
            ESP_LOGW(kTag, "STA disconnected: reason=%d want_reconnect=%d fail_count=%d/%d", d->reason, want_reconnect,
                     fail_count, self->max_fast_fail_);
            self->last_disconnect_reason_.store(d->reason, std::memory_order_release);
            DisconnectCb on_disconnect;
            {
                std::lock_guard<std::mutex> lock(self->callback_mutex_);
                on_disconnect = self->on_disconnect_;
            }
            if (on_disconnect)
                on_disconnect(d->reason);

            if (!want_reconnect) {
                // TryConnect 验证完主动断 / Disconnect() / StopAp / Stop:都属于主动断,
                // 不再重连。Connect() 也会在同步等待超时后置 want_reconnect_=false,
                // 让上层走 captive portal fallback。
                self->state_.store(State::Disconnected);
                xEventGroupSetBits(s_event_group, BIT_FAIL);
                return;
            }

            if (fail_count < self->max_fast_fail_) {
                // 快速 retry:STA_DISCONNECTED 立即 esp_wifi_connect。fast_scan 路径,
                // 适合 AP 短暂抖动 / beacon 偶发丢失场景。
                self->fail_count_.fetch_add(1, std::memory_order_acq_rel);
                esp_err_t e = esp_wifi_connect();
                if (e != ESP_OK) {
                    ESP_LOGW(kTag, "ESP wifi_connect retry failed: %s", esp_err_to_name(e));
                }
                return;
            }

            // 快速 retry 用完 → 转慢速 scan-then-connect。BIT_FAIL 同步通知 Connect()
            // 同步等待方,让它的 timeout 之外也能立刻退出(选择走 captive portal)。
            self->state_.store(State::Disconnected);
            xEventGroupSetBits(s_event_group, BIT_FAIL);
            self->ScheduleSlowReconnect();
            return;
        }

        if (id == WIFI_EVENT_SCAN_DONE) {
            // 仅响应慢速重连发起的 scan;captive portal 用的 /scan 端点是 blocking
            // (esp_wifi_scan_start(_, true)),不会走到 SCAN_DONE event。
            if (self->slow_scan_pending_.exchange(false, std::memory_order_acq_rel)) {
                self->HandleSlowScanResult();
            }
            return;
        }

        if (id == WIFI_EVENT_AP_STACONNECTED) {
            return;
        }
        if (id == WIFI_EVENT_AP_STADISCONNECTED) {
            return;
        }
        return;
    }

    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* e = static_cast<ip_event_got_ip_t*>(data);
        char  ip[INET6_ADDRSTRLEN];
        std::snprintf(ip, sizeof(ip), IPSTR, IP2STR(&e->ip_info.ip));
        self->SetIpString(ip);
        // 重置 fast retry 配额 + 慢速 backoff:下次断开重新从最快重试开始。
        self->fail_count_.store(0, std::memory_order_release);
        self->backoff_idx_.store(0, std::memory_order_release);
        self->StopSlowReconnect();
        self->state_.store(State::Connected);
        xEventGroupSetBits(s_event_group, BIT_CONNECTED);
        return;
    }
}

void Wifi::RegisterEventHandlers() {
    if (handler_wifi_ || handler_ip_)
        return;
    ESP_ERROR_CHECK(
        esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &EventHandler, this, &handler_wifi_));
    ESP_ERROR_CHECK(
        esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &EventHandler, this, &handler_ip_));
}

void Wifi::UnregisterEventHandlers() {
    if (handler_wifi_) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, handler_wifi_);
        handler_wifi_ = nullptr;
    }
    if (handler_ip_) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, handler_ip_);
        handler_ip_ = nullptr;
    }
}

void Wifi::Init() {
    std::lock_guard<std::mutex> init_lock(init_mutex_);
    if (inited_)
        return;

    // NVS:cred 存储依赖 NVS。Board::InitPower 之前应已 init,这里幂等再调一次。
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    err = esp_netif_init();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);
    err = esp_event_loop_create_default();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);

    // 关键:nvs_enable=false 禁用 wifi 内置 NVS 持久化,否则 mode/config 会被
    // 写入 NVS,重启后 wifi 自动恢复 → 出现"配过网重启 AP 还在"的诡异现象。
    // 凭据由 cred_store 自己管。
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    cfg.nvs_enable         = false;
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    if (!s_event_group)
        s_event_group = xEventGroupCreate();
    configASSERT(s_event_group != nullptr);
    inited_       = true;
}

// ─── STA 模式生命周期 ──────────────────────────────────────────────
void Wifi::StartStationInternal() {
    // 调用方保证 mode_ != Station
    sta_netif_ = esp_netif_create_default_wifi_sta();
    RegisterEventHandlers();
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    mode_.store(Mode::Station, std::memory_order_release);
}

void Wifi::StopStationInternal() {
    if (mode_.load(std::memory_order_acquire) != Mode::Station)
        return;
    StopSlowReconnect();
    UnregisterEventHandlers();
    esp_wifi_disconnect();
    esp_wifi_stop();
    if (sta_netif_) {
        esp_netif_destroy_default_wifi(sta_netif_);
        sta_netif_ = nullptr;
    }
    state_.store(State::Idle);
    want_reconnect_.store(false, std::memory_order_release);
    ClearIpString();
    mode_.store(Mode::Off, std::memory_order_release);
}

// ─── AP 模式生命周期 ───────────────────────────────────────────────
void Wifi::StartApInternal(const std::string& ssid_prefix) {
    // 调用方保证 mode_ != AccessPoint。先清掉可能的旧 STA。
    if (mode_.load(std::memory_order_acquire) == Mode::Station)
        StopStationInternal();

    // APSTA 共存:配网期 TryConnect 复用同一个 wifi 跑 STA 验证。
    // sta_netif 也要在此创建,否则 STA 拿不到 IP(GOT_IP 不会触发)。
    ap_netif_  = esp_netif_create_default_wifi_ap();
    sta_netif_ = esp_netif_create_default_wifi_sta();
    RegisterEventHandlers();

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[32];
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", ssid_prefix.c_str(), mac[4], mac[5]);

    wifi_config_t apc = {};
    std::strncpy(reinterpret_cast<char*>(apc.ap.ssid), ssid, sizeof(apc.ap.ssid) - 1);
    apc.ap.ssid_len        = std::strlen(ssid);
    apc.ap.channel         = 6;
    apc.ap.max_connection  = 4;
    apc.ap.authmode        = WIFI_AUTH_OPEN;
    apc.ap.beacon_interval = 100;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &apc));
    ESP_ERROR_CHECK(esp_wifi_start());
    mode_.store(Mode::AccessPoint, std::memory_order_release);
}

void Wifi::StopApInternal() {
    if (mode_.load(std::memory_order_acquire) != Mode::AccessPoint)
        return;
    StopSlowReconnect();
    UnregisterEventHandlers();
    // STA 在 APSTA 期间可能临时连过(TryConnect),先 disconnect
    esp_wifi_disconnect();
    esp_wifi_stop();
    if (ap_netif_) {
        esp_netif_destroy_default_wifi(ap_netif_);
        ap_netif_ = nullptr;
    }
    if (sta_netif_) {
        esp_netif_destroy_default_wifi(sta_netif_);
        sta_netif_ = nullptr;
    }
    state_.store(State::Idle);
    want_reconnect_.store(false, std::memory_order_release);
    ClearIpString();
    mode_.store(Mode::Off, std::memory_order_release);
}

// ─── 公共 API ─────────────────────────────────────────────────────
bool Wifi::Connect(const std::string& ssid, const std::string& password, int timeout_ms) {
    Init();
    if (ssid.empty()) {
        ESP_LOGW(kTag, "Connect: empty SSID");
        return false;
    }
    if (mode_.load(std::memory_order_acquire) == Mode::AccessPoint)
        StopApInternal();
    if (mode_.load(std::memory_order_acquire) != Mode::Station)
        StartStationInternal();

    wifi_config_t wc = {};
    if (!FillStaConfig(wc, ssid, password, nullptr)) {
        ESP_LOGW(kTag, "Connect: invalid Wi-Fi credentials ssid_len=%u password_len=%u", static_cast<unsigned>(ssid.size()),
                 static_cast<unsigned>(password.size()));
        return false;
    }
    // 空密码兼容,密码非空 wifi 自动升 WPA2
    // 首次 Connect 用默认 fast_scan(scan_method=0)。一旦 fast retry 全失败,
    // 慢速重连里会切到 ALL_CHANNEL_SCAN 主动扫,绕开 fast_scan 偏好旧 BSSID 的弱点。
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    state_.store(State::Connecting);
    fail_count_.store(0, std::memory_order_release);
    backoff_idx_.store(0, std::memory_order_release);
    want_reconnect_.store(true, std::memory_order_release);

    xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
    // disconnect 是幂等的:首次进入 STA 还没连过,会返 NOT_CONNECTED 但无副作用
    esp_wifi_disconnect();
    esp_wifi_connect();

    EventBits_t bits =
        xEventGroupWaitBits(s_event_group, BIT_CONNECTED | BIT_FAIL, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (bits & BIT_CONNECTED) {
        // STA 关联后开 modem-sleep:WiFi 在 DTIM 周期之间自动断 RF,
        // 平均功耗从 ~80mA 降到 ~5mA。MIN_MODEM 是温和档,不影响接收实时性。
        esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
        return true;
    }
    // 同步等待超时或 fast retry 已用完 → 关闭自愈,避免跟调用方接下来要走的
    // captive portal fallback (StartApInternal) 状态机打架。
    ESP_LOGW(kTag, "STA connect timeout/fail (last_reason=%d), disabling auto-reconnect",
             last_disconnect_reason_.load(std::memory_order_acquire));
    want_reconnect_.store(false, std::memory_order_release);
    StopSlowReconnect();
    state_.store(State::Disconnected);
    return false;
}

// reason 翻译,参考 ESP-IDF v5.5 wifi_err_reason_t (esp_wifi_types.h)
static std::string DisconnectReasonZh(int reason) {
    switch (reason) {
        case 1:
            return "未指定原因";  // UNSPECIFIED
        case 2:
            return "auth 失败";
        case 3:
            return "路由器主动断开(auth)";  // AUTH_LEAVE
        case 4:
            return "associate 超时";  // ASSOC_EXPIRE
        case 5:
            return "AP 客户端过多";  // ASSOC_TOOMANY
        case 6:
            return "未认证";  // NOT_AUTHED
        case 7:
            return "未关联";  // NOT_ASSOCED
        case 8:
            return "本机断开(assoc-leave,常见于配置切换)";
        case 14:
            return "MIC 失败,密码错";  // MIC_FAILURE
        case 15:
            return "4-way handshake 超时(密码错)";
        case 200:
            return "信号弱或路由器无 beacon";  // BEACON_TIMEOUT
        case 201:
            return "未找到该 SSID";  // NO_AP_FOUND
        case 202:
            return "认证失败,密码错";  // AUTH_FAIL
        case 203:
            return "associate 失败";  // ASSOC_FAIL
        case 204:
            return "握手超时";  // HANDSHAKE_TIMEOUT
        case 205:
            return "连接失败";  // CONNECTION_FAIL
        default: {
            char buf[48];
            std::snprintf(buf, sizeof(buf), "连接失败 (reason=%d)", reason);
            return buf;
        }
    }
}

bool Wifi::TryConnect(const std::string& ssid, const std::string& password, int timeout_ms, std::string& out_reason) {
    Init();
    if (ssid.empty()) {
        out_reason = "SSID 不能为空";
        return false;
    }
    if (mode_.load(std::memory_order_acquire) != Mode::AccessPoint) {
        out_reason = "TryConnect 必须在配网模式下调用";
        ESP_LOGE(kTag, "TryConnect called without AP mode");
        return false;
    }
    // 不开 want_reconnect_:重试由本函数控制,EventHandler 不要自动重连
    want_reconnect_.store(false, std::memory_order_release);
    fail_count_.store(0, std::memory_order_release);
    last_disconnect_reason_.store(0, std::memory_order_release);
    StopSlowReconnect();

    wifi_config_t wc = {};
    if (!FillStaConfig(wc, ssid, password, &out_reason))
        return false;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    // 8s/轮:auth+assoc+4way+DHCP 在 APSTA 共存(同信道复用)下偶尔会接近 5~6s
    constexpr int kMaxAttempts         = 3;
    constexpr int kPerAttemptTimeoutMs = 8000;
    const int     total_budget         = std::max(timeout_ms, kPerAttemptTimeoutMs);
    const int64_t deadline_ms          = (esp_timer_get_time() / 1000) + total_budget;

    int last_reason = 0;
    for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
        const int64_t now_ms      = esp_timer_get_time() / 1000;
        const int     budget_left = static_cast<int>(deadline_ms - now_ms);
        if (budget_left <= 0)
            break;
        const int wait_ms = std::min(budget_left, kPerAttemptTimeoutMs);

        xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "ESP wifi_connect attempt %d failed: %s", attempt, esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(300));
            continue;
        }

        EventBits_t bits =
            xEventGroupWaitBits(s_event_group, BIT_CONNECTED | BIT_FAIL, pdFALSE, pdFALSE, pdMS_TO_TICKS(wait_ms));

        if (bits & BIT_CONNECTED) {
            // 验证完 disconnect STA,但保留 AP 让浏览器收到成功页
            esp_wifi_disconnect();
            // 主动 disconnect 触发 STA_DISCONNECTED,want_reconnect_=false 时
            // EventHandler 进 intentional-disconnect 分支并置 BIT_FAIL。清掉避免污染下次。
            state_.store(State::Idle);
            xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
            return true;
        }
        if (bits & BIT_FAIL) {
            last_reason = last_disconnect_reason_.load(std::memory_order_acquire);
            ESP_LOGW(kTag, "TryConnect attempt %d failed: reason=%d", attempt, last_reason);
            vTaskDelay(pdMS_TO_TICKS(300));
        } else {
            ESP_LOGW(kTag, "TryConnect attempt %d timeout (%dms)", attempt, wait_ms);
            esp_wifi_disconnect();  // 卡在中间态,拉回 init 再试
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }

    if (last_reason != 0) {
        out_reason = DisconnectReasonZh(last_reason);
    } else {
        out_reason = "连接超时,可能信号弱或路由器无响应";
    }
    esp_wifi_disconnect();
    ESP_LOGW(kTag, "TryConnect all attempts failed: %s", out_reason.c_str());
    return false;
}

void Wifi::Disconnect() {
    want_reconnect_.store(false, std::memory_order_release);
    StopSlowReconnect();
    if (mode_.load(std::memory_order_acquire) == Mode::Station) {
        esp_wifi_disconnect();
    }
    state_.store(State::Disconnected);
}

bool Wifi::IsConnected() const {
    return state_.load() == State::Connected;
}

int8_t Wifi::GetRssi() const {
    if (!IsConnected())
        return 0;
    wifi_ap_record_t r;
    if (esp_wifi_sta_get_ap_info(&r) == ESP_OK)
        return r.rssi;
    return 0;
}

std::string Wifi::GetIp() const {
    std::lock_guard<std::mutex> lock(ip_mutex_);
    return ip_str_;
}

void Wifi::SetIpString(const char* ip) {
    std::lock_guard<std::mutex> lock(ip_mutex_);
    std::snprintf(ip_str_, sizeof(ip_str_), "%s", ip ? ip : "");
}

void Wifi::ClearIpString() {
    SetIpString("");
}

bool Wifi::StartAp(const std::string& ssid_prefix) {
    Init();
    if (mode_.load(std::memory_order_acquire) == Mode::AccessPoint) {
        ESP_LOGW(kTag, "StartAp called but already in AP mode");
        return true;
    }
    StartApInternal(ssid_prefix);
    return true;
}

void Wifi::StopAp() {
    StopApInternal();
}

void Wifi::OnDisconnected(DisconnectCb cb) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    on_disconnect_ = std::move(cb);
}

// ─── 慢速重连子系统 ───────────────────────────────────────────────
void Wifi::EnsureReconnectTimer() {
    if (reconnect_timer_)
        return;
    const esp_timer_create_args_t args = {
        .callback              = &OnSlowReconnectTimer,
        .arg                   = this,
        .dispatch_method       = ESP_TIMER_TASK,
        .name                  = "wifi_slow_rc",
        .skip_unhandled_events = true,
    };
    ESP_ERROR_CHECK(esp_timer_create(&args, &reconnect_timer_));
}

void Wifi::ScheduleSlowReconnect() {
    if (!want_reconnect_.load(std::memory_order_acquire)) {
        return;
    }
    EnsureReconnectTimer();
    const size_t   idx     = std::min(backoff_idx_.load(std::memory_order_acquire), kBackoffSize - 1);
    const uint32_t seconds = kBackoffSec[idx];
    esp_timer_stop(reconnect_timer_);  // 幂等,无活跃 timer 时返回 ESP_ERR_INVALID_STATE
    ESP_ERROR_CHECK(esp_timer_start_once(reconnect_timer_, (uint64_t)seconds * 1000ULL * 1000ULL));
    if (idx < kBackoffSize - 1)
        backoff_idx_.store(idx + 1, std::memory_order_release);
}

void Wifi::StopSlowReconnect() {
    if (reconnect_timer_) {
        esp_err_t err = esp_timer_stop(reconnect_timer_);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(kTag, "esp_timer_stop failed: %s", esp_err_to_name(err));
        }
    }
    slow_scan_pending_.store(false, std::memory_order_release);
}

void Wifi::OnSlowReconnectTimer(void* arg) {
    auto* self = static_cast<Wifi*>(arg);
    if (!self->want_reconnect_.load(std::memory_order_acquire) ||
        self->mode_.load(std::memory_order_acquire) != Mode::Station) {
        return;
    }
    self->DoSlowScanReconnect();
}

void Wifi::DoSlowScanReconnect() {
    // 重置 fast retry 配额:接下来 scan 找到 AP 后 connect,允许新一轮 5 次快速 retry。
    fail_count_.store(0, std::memory_order_release);
    state_.store(State::Connecting);
    slow_scan_pending_.store(true, std::memory_order_release);

    // 主动全信道扫,scan_method 跟 wifi_config_t.sta.scan_method 是不同的旋钮:
    // 这里直接调 esp_wifi_scan_start 不依赖 wc.sta 设置,扫到的所有 AP 由
    // HandleSlowScanResult 按 RSSI 排序后筛 ssid 匹配。
    wifi_scan_config_t scan_cfg   = {};
    scan_cfg.ssid                 = nullptr;
    scan_cfg.bssid                = nullptr;
    scan_cfg.channel              = 0;     // 全信道
    scan_cfg.show_hidden          = true;  // 隐藏 SSID 也扫,允许用户配过隐藏 wifi
    scan_cfg.scan_type            = WIFI_SCAN_TYPE_ACTIVE;
    scan_cfg.scan_time.active.min = 0;
    scan_cfg.scan_time.active.max = 120;  // 120 ms × 13 信道 ≈ 1.6 s，够快又能扫全

    esp_err_t err = esp_wifi_scan_start(&scan_cfg, false /* async */);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "ESP wifi_scan_start failed: %s, reschedule", esp_err_to_name(err));
        slow_scan_pending_.store(false, std::memory_order_release);
        ScheduleSlowReconnect();
    }
}

void Wifi::HandleSlowScanResult() {
    uint16_t ap_num = 0;
    esp_wifi_scan_get_ap_num(&ap_num);
    if (ap_num == 0) {
        ScheduleSlowReconnect();
        return;
    }
    ap_num = std::min<uint16_t>(ap_num, kMaxSlowScanRecords);
    std::array<wifi_ap_record_t, kMaxSlowScanRecords> records{};
    esp_wifi_scan_get_ap_records(&ap_num, records.data());
    std::sort(records.begin(), records.begin() + ap_num,
              [](const wifi_ap_record_t& a, const wifi_ap_record_t& b) { return a.rssi > b.rssi; });

    // 拿当前配置的 ssid (Connect/TryConnect 时 set_config 进去,esp_wifi_get_config 取回)
    wifi_config_t wc = {};
    if (esp_wifi_get_config(WIFI_IF_STA, &wc) != ESP_OK) {
        ESP_LOGW(kTag, "ESP wifi_get_config failed in slow scan handler");
        ScheduleSlowReconnect();
        return;
    }
    if (wc.sta.ssid[0] == '\0') {
        ESP_LOGW(kTag, "Slow scan: no target SSID in current config, abort");
        return;
    }
    const wifi_ap_record_t* match = nullptr;
    for (uint16_t i = 0; i < ap_num; ++i) {
        if (SsidEquals(records[i].ssid, wc.sta.ssid)) {
            match = &records[i];
            break;
        }
    }

    if (!match) {
        ScheduleSlowReconnect();
        return;
    }

    // 锁定 BSSID + channel 让 IDF 直接连这个 AP,避开下一轮 fast_scan 又回到旧 BSSID。
    wc.sta.bssid_set = 1;
    std::memcpy(wc.sta.bssid, match->bssid, 6);
    wc.sta.channel = match->primary;
    esp_wifi_set_config(WIFI_IF_STA, &wc);

    // 触发 connect。失败会走 STA_DISCONNECTED → fast retry → 满了再 ScheduleSlowReconnect。
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "ESP wifi_connect after slow scan failed: %s", esp_err_to_name(err));
        ScheduleSlowReconnect();
    }
}
