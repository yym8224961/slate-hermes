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
#include <cstdio>
#include <cstring>

namespace {
constexpr char kTag[] = "Wifi";
}

static EventGroupHandle_t s_event_group = nullptr;
static constexpr int      BIT_CONNECTED = BIT0;
static constexpr int      BIT_FAIL      = BIT1;

Wifi& Wifi::Get() {
    static Wifi w;
    return w;
}

void Wifi::EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data) {
    Wifi* self = static_cast<Wifi*>(arg);

    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_START) {
            esp_wifi_connect();
        } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
            auto* d = static_cast<wifi_event_sta_disconnected_t*>(data);
            ESP_LOGW(kTag, "STA disconnected, reason=%d", d->reason);
            self->last_disconnect_reason_ = d->reason;
            if (self->on_disconnect_) self->on_disconnect_(d->reason);
            if (self->want_reconnect_ && self->fail_count_ < self->max_fail_) {
                self->fail_count_++;
                ESP_LOGI(kTag, "retry STA connect (%d/%d)", self->fail_count_, self->max_fail_);
                esp_wifi_connect();
            } else {
                self->state_.store(State::Failed);
                xEventGroupSetBits(s_event_group, BIT_FAIL);
            }
        } else if (id == WIFI_EVENT_AP_STACONNECTED) {
            auto* e = static_cast<wifi_event_ap_staconnected_t*>(data);
            ESP_LOGI(kTag, "AP client connected: " MACSTR, MAC2STR(e->mac));
        } else if (id == WIFI_EVENT_AP_STADISCONNECTED) {
            auto* e = static_cast<wifi_event_ap_stadisconnected_t*>(data);
            ESP_LOGI(kTag, "AP client disconnected: " MACSTR, MAC2STR(e->mac));
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* e = static_cast<ip_event_got_ip_t*>(data);
        snprintf(self->ip_str_, sizeof(self->ip_str_), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(kTag, "STA got IP: %s", self->ip_str_);
        self->fail_count_ = 0;
        self->state_.store(State::Connected);
        xEventGroupSetBits(s_event_group, BIT_CONNECTED);
    }
}

void Wifi::Init() {
    if (inited_) return;

    // NVS:wifi 凭据存储依赖 NVS。Board::InitPower 之前就该调 nvs_flash_init。
    // 这里再调一次幂等。
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    sta_netif_ = esp_netif_create_default_wifi_sta();
    ap_netif_  = esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    s_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &EventHandler, this));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &EventHandler, this));

    inited_ = true;
}

bool Wifi::Connect(const std::string& ssid, const std::string& password, int timeout_ms) {
    Init();
    if (ssid.empty()) {
        ESP_LOGW(kTag, "Connect: empty SSID");
        return false;
    }

    // 切到 STA 模式(若已经在 AP+STA 共存,保持)
    wifi_mode_t cur;
    esp_wifi_get_mode(&cur);
    if (cur == WIFI_MODE_AP) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    } else if (cur != WIFI_MODE_STA && cur != WIFI_MODE_APSTA) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    }

    wifi_config_t wc = {};
    std::strncpy(reinterpret_cast<char*>(wc.sta.ssid), ssid.c_str(), sizeof(wc.sta.ssid) - 1);
    std::strncpy(reinterpret_cast<char*>(wc.sta.password), password.c_str(), sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;  // 兼容开放/密码两种,密码空就当开放
    wc.sta.pmf_cfg.capable    = true;
    wc.sta.pmf_cfg.required   = false;

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    if (!sta_active_) {
        ESP_ERROR_CHECK(esp_wifi_start());
        sta_active_ = true;
    } else {
        // 已经 start 过,主动断开后 reconnect 让新 ssid 生效
        esp_wifi_disconnect();
        esp_wifi_connect();
    }
    // STA 关联后开 modem-sleep:WiFi 在 DTIM 周期之间自动断 RF,
    // 平均功耗从 ~80mA 降到 ~5mA。MIN_MODEM 是温和档(更短的 sleep),
    // 不影响接收实时性,适合定期心跳的产品。
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

    state_.store(State::Connecting);
    fail_count_     = 0;
    want_reconnect_ = true;

    xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
    EventBits_t bits = xEventGroupWaitBits(s_event_group, BIT_CONNECTED | BIT_FAIL, pdFALSE,
                                           pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (bits & BIT_CONNECTED) {
        ESP_LOGI(kTag, "STA connected to %s", ssid.c_str());
        return true;
    }
    ESP_LOGW(kTag, "STA connect timeout/fail to %s", ssid.c_str());
    state_.store(State::Failed);
    return false;
}

// reason 翻译,参考 ESP-IDF v5.5 wifi_err_reason_t (esp_wifi_types.h):
//   200 = BEACON_TIMEOUT、201 = NO_AP_FOUND、202 = AUTH_FAIL、
//   203 = ASSOC_FAIL、204 = HANDSHAKE_TIMEOUT、205 = CONNECTION_FAIL
static std::string DisconnectReasonZh(int reason) {
    switch (reason) {
        case 2:    return "auth 失败";
        case 3:    return "路由器主动断开(auth)";          // AUTH_LEAVE
        case 4:    return "associate 超时";                // ASSOC_EXPIRE
        case 5:    return "AP 客户端过多";                 // ASSOC_TOOMANY
        case 6:    return "未认证";                        // NOT_AUTHED
        case 7:    return "未关联";                        // NOT_ASSOCED
        case 8:    return "本机断开(assoc-leave,常见于配置切换)";  // ASSOC_LEAVE 是本机发起,不是路由器
        case 14:   return "MIC 失败,密码错";              // MIC_FAILURE
        case 15:   return "4-way handshake 超时(密码错)";  // 4WAY_HANDSHAKE_TIMEOUT
        case 200:  return "信号弱或路由器无 beacon";       // BEACON_TIMEOUT
        case 201:  return "未找到该 SSID";                 // NO_AP_FOUND
        case 202:  return "认证失败,密码错";              // AUTH_FAIL
        case 203:  return "associate 失败";                // ASSOC_FAIL
        case 204:  return "握手超时";                      // HANDSHAKE_TIMEOUT
        case 205:  return "连接失败";                      // CONNECTION_FAIL
        default: {
            // 改可重入:返 std::string,各调用方可独立持有,不再共享 static buf
            char buf[48];
            std::snprintf(buf, sizeof(buf), "连接失败 (reason=%d)", reason);
            return buf;
        }
    }
}

bool Wifi::TryConnect(const std::string& ssid, const std::string& password,
                      int timeout_ms, std::string& out_reason) {
    Init();
    if (ssid.empty()) {
        out_reason = "SSID 不能为空";
        return false;
    }
    // 明文凭据日志:仅 CONFIG_SLATE_LOG_PLAINTEXT_CRED=y 时打开,默认关。
    // 生产构建严禁开启 — 任何接 USB 看 monitor 的人都能拿到 WiFi 密码。
#if CONFIG_SLATE_LOG_PLAINTEXT_CRED
    ESP_LOGW(kTag, "TryConnect ssid='%s' pwd='%s' (len=%u)",
             ssid.c_str(), password.c_str(), (unsigned)password.size());
#else
    ESP_LOGI(kTag, "TryConnect ssid='%s' pwd_len=%u", ssid.c_str(), (unsigned)password.size());
#endif

    // 必须 APSTA 共存模式(captive portal 已经把 AP 起着了)
    wifi_mode_t cur;
    esp_wifi_get_mode(&cur);
    if (cur != WIFI_MODE_APSTA) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    }

    // 关键:不开 want_reconnect_,不让 EventHandler 自动重连;重试由本函数控制。
    want_reconnect_ = false;
    fail_count_     = 0;
    last_disconnect_reason_ = 0;

    // 如果 STA 当前还连着其他 AP,先优雅断开并等事件落位。
    // 不这样做的话,后面 set_config + connect 会撞到旧连接,且我们自己发起的
    // disconnect 产生的 reason=8 事件会污染 BIT_FAIL,首轮 waitBits 立刻假失败。
    if (state_.load() == State::Connected || sta_active_) {
        xEventGroupClearBits(s_event_group, BIT_FAIL);
        esp_wifi_disconnect();
        // 最多等 500ms 让 DISCONNECTED 事件回到 EventHandler
        xEventGroupWaitBits(s_event_group, BIT_FAIL, pdTRUE, pdFALSE, pdMS_TO_TICKS(500));
    }
    state_.store(State::Connecting);

    wifi_config_t wc = {};
    std::strncpy(reinterpret_cast<char*>(wc.sta.ssid), ssid.c_str(), sizeof(wc.sta.ssid) - 1);
    std::strncpy(reinterpret_cast<char*>(wc.sta.password), password.c_str(), sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable    = true;
    wc.sta.pmf_cfg.required   = false;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    if (!sta_active_) {
        ESP_ERROR_CHECK(esp_wifi_start());
        sta_active_ = true;
    }

    // 8s/轮:auth+assoc+4way+DHCP 在 APSTA 共存(同信道复用)下偶尔会接近 5~6s
    constexpr int kMaxAttempts         = 3;
    constexpr int kPerAttemptTimeoutMs = 8000;
    const int     total_budget         = std::max(timeout_ms, kPerAttemptTimeoutMs);
    const int64_t deadline_ms          = (esp_timer_get_time() / 1000) + total_budget;

    int last_reason = 0;
    for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
        const int64_t now_ms      = esp_timer_get_time() / 1000;
        const int     budget_left = static_cast<int>(deadline_ms - now_ms);
        if (budget_left <= 0) break;
        const int     wait_ms     = std::min(budget_left, kPerAttemptTimeoutMs);

        xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "esp_wifi_connect attempt %d failed: %s", attempt, esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(300));
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(
            s_event_group, BIT_CONNECTED | BIT_FAIL, pdFALSE, pdFALSE,
            pdMS_TO_TICKS(wait_ms));

        if (bits & BIT_CONNECTED) {
            ESP_LOGI(kTag, "TryConnect %s OK on attempt %d, disconnecting to free AP",
                     ssid.c_str(), attempt);
            // 配网期间也开 modem-sleep,即便配完没断也省电
            esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
            // 配网期需要让 AP 还活着回浏览器"成功"页,所以此处主动 disconnect。
            // 上层 App 拿到 true 之后会保存凭据并重启,重启后走正常 Connect。
            esp_wifi_disconnect();
            // 主动 disconnect 会触发一次 STA_DISCONNECTED 事件,在 want_reconnect_=false
            // 时 EventHandler 会把 state_ 切到 Failed、置 BIT_FAIL。如果不清掉,
            // 调用方读 state() 会以为 TryConnect 失败,下一轮 Connect 也可能误命中残留。
            // 重启路径上不会真去读,但接口语义上必须自洽。
            state_.store(State::Idle);
            xEventGroupClearBits(s_event_group, BIT_CONNECTED | BIT_FAIL);
            return true;
        }
        if (bits & BIT_FAIL) {
            last_reason = last_disconnect_reason_;
            ESP_LOGW(kTag, "TryConnect attempt %d failed: reason=%d", attempt, last_reason);
            // 给 wifi 内部状态机一点时间稳定再重试
            vTaskDelay(pdMS_TO_TICKS(300));
        } else {
            ESP_LOGW(kTag, "TryConnect attempt %d timeout (%dms)", attempt, wait_ms);
            // 超时通常意味着卡在某个中间态,主动 disconnect 把状态拉回 init 再试
            esp_wifi_disconnect();
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }

    // 所有尝试用尽
    if (last_reason != 0) {
        out_reason = DisconnectReasonZh(last_reason);
    } else {
        out_reason = "连接超时,可能信号弱或路由器无响应";
    }
    esp_wifi_disconnect();
    ESP_LOGW(kTag, "TryConnect %s all attempts failed: %s", ssid.c_str(), out_reason.c_str());
    return false;
}

void Wifi::Disconnect() {
    want_reconnect_ = false;
    if (sta_active_) {
        esp_wifi_disconnect();
    }
    state_.store(State::Disconnected);
}

bool Wifi::IsConnected() const {
    return state_.load() == State::Connected;
}

int8_t Wifi::GetRssi() const {
    if (!IsConnected()) return 0;
    wifi_ap_record_t r;
    if (esp_wifi_sta_get_ap_info(&r) == ESP_OK) return r.rssi;
    return 0;
}

std::string Wifi::GetIp() const {
    return ip_str_;
}

bool Wifi::StartAp(const std::string& ssid_prefix) {
    Init();
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[32];
    std::snprintf(ssid, sizeof(ssid), "%s-%02X%02X", ssid_prefix.c_str(), mac[4], mac[5]);

    // 共存模式:配网完成切 STA 后,AP 还能短暂运行让浏览器看到"完成"页
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));

    wifi_config_t apc = {};
    std::strncpy(reinterpret_cast<char*>(apc.ap.ssid), ssid, sizeof(apc.ap.ssid) - 1);
    apc.ap.ssid_len      = std::strlen(ssid);
    apc.ap.channel       = 6;
    apc.ap.max_connection = 4;
    apc.ap.authmode      = WIFI_AUTH_OPEN;  // 无密码,方便手机扫到就连
    apc.ap.beacon_interval = 100;

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &apc));
    if (!sta_active_ && !ap_active_) {
        ESP_ERROR_CHECK(esp_wifi_start());
        sta_active_ = true;
    }
    ap_active_ = true;
    ESP_LOGI(kTag, "SoftAP started: SSID=%s, IP=192.168.4.1", ssid);
    return true;
}

void Wifi::StopAp() {
    if (!ap_active_) return;
    // 不直接 stop wifi(STA 还在用),而是切到 STA-only 模式,AP 自动停
    wifi_mode_t cur;
    esp_wifi_get_mode(&cur);
    if (cur == WIFI_MODE_APSTA) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    } else if (cur == WIFI_MODE_AP) {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_NULL));
        sta_active_ = false;
    }
    ap_active_ = false;
    ESP_LOGI(kTag, "SoftAP stopped");
}

void Wifi::OnDisconnected(DisconnectCb cb) {
    on_disconnect_ = std::move(cb);
}
