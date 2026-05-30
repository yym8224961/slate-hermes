#include "network/wifi.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>

#include <algorithm>
#include <cstdio>
#include <utility>

#include "network/wifi_internal.h"
#include "utils/time_utils.h"

Wifi& Wifi::Get() {
    static Wifi w;
    return w;
}

void Wifi::EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data) {
    Wifi* self = static_cast<Wifi*>(arg);

    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_DISCONNECTED) {
            auto*      d              = static_cast<wifi_event_sta_disconnected_t*>(data);
            const bool want_reconnect = self->want_reconnect_.load(std::memory_order_acquire);
            const int  fail_count     = self->fail_count_.load(std::memory_order_acquire);
            ESP_LOGW(wifi_internal::kTag, "STA disconnected: reason=%d want_reconnect=%d fail_count=%d/%d",
                     d->reason, want_reconnect, fail_count, self->max_fast_fail_);
            self->last_disconnect_reason_.store(d->reason, std::memory_order_release);
            DisconnectCb on_disconnect;
            {
                std::lock_guard<std::mutex> lock(self->callback_mutex_);
                on_disconnect = self->on_disconnect_;
            }
            if (on_disconnect)
                on_disconnect(d->reason);

            if (!want_reconnect) {
                self->state_.store(State::Disconnected);
                xEventGroupSetBits(wifi_internal::EventGroup(), wifi_internal::BIT_FAIL);
                return;
            }

            if (fail_count < self->max_fast_fail_) {
                self->fail_count_.fetch_add(1, std::memory_order_acq_rel);
                esp_err_t e = esp_wifi_connect();
                if (e != ESP_OK) {
                    ESP_LOGW(wifi_internal::kTag, "ESP wifi_connect retry failed: %s", esp_err_to_name(e));
                }
                return;
            }

            self->state_.store(State::Disconnected);
            xEventGroupSetBits(wifi_internal::EventGroup(), wifi_internal::BIT_FAIL);
            self->ScheduleSlowReconnect();
            return;
        }

        if (id == WIFI_EVENT_SCAN_DONE) {
            if (self->slow_scan_pending_.exchange(false, std::memory_order_acq_rel)) {
                self->HandleSlowScanResult();
            }
            return;
        }
        return;
    }

    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* e = static_cast<ip_event_got_ip_t*>(data);
        char  ip[INET6_ADDRSTRLEN];
        std::snprintf(ip, sizeof(ip), IPSTR, IP2STR(&e->ip_info.ip));
        self->SetIpString(ip);
        self->fail_count_.store(0, std::memory_order_release);
        self->backoff_idx_.store(0, std::memory_order_release);
        self->StopSlowReconnect();
        self->state_.store(State::Connected);
        xEventGroupSetBits(wifi_internal::EventGroup(), wifi_internal::BIT_CONNECTED);
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

    esp_err_t err = esp_netif_init();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);
    err = esp_event_loop_create_default();
    ESP_ERROR_CHECK(err == ESP_ERR_INVALID_STATE ? ESP_OK : err);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    cfg.nvs_enable         = false;
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_internal::EnsureEventGroup();
    inited_ = true;
}

bool Wifi::Connect(const std::string& ssid, const std::string& password, int timeout_ms) {
    Init();
    if (ssid.empty()) {
        ESP_LOGW(wifi_internal::kTag, "Connect: empty SSID");
        return false;
    }
    if (mode_.load(std::memory_order_acquire) == Mode::AccessPoint)
        StopApInternal();
    if (mode_.load(std::memory_order_acquire) != Mode::Station)
        StartStationInternal();

    wifi_config_t wc = {};
    if (!wifi_internal::FillStaConfig(wc, ssid, password, nullptr)) {
        ESP_LOGW(wifi_internal::kTag, "Connect: invalid Wi-Fi credentials ssid_len=%u password_len=%u",
                 static_cast<unsigned>(ssid.size()), static_cast<unsigned>(password.size()));
        return false;
    }
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    state_.store(State::Connecting);
    fail_count_.store(0, std::memory_order_release);
    backoff_idx_.store(0, std::memory_order_release);
    want_reconnect_.store(true, std::memory_order_release);

    xEventGroupClearBits(wifi_internal::EventGroup(), wifi_internal::BIT_CONNECTED | wifi_internal::BIT_FAIL);
    esp_wifi_disconnect();
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(wifi_internal::EventGroup(),
                                           wifi_internal::BIT_CONNECTED | wifi_internal::BIT_FAIL, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if (bits & wifi_internal::BIT_CONNECTED) {
        esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
        return true;
    }

    ESP_LOGW(wifi_internal::kTag, "STA connect timeout/fail (last_reason=%d), disabling auto-reconnect",
             last_disconnect_reason_.load(std::memory_order_acquire));
    want_reconnect_.store(false, std::memory_order_release);
    StopSlowReconnect();
    state_.store(State::Disconnected);
    return false;
}

bool Wifi::TryConnect(const std::string& ssid, const std::string& password, int timeout_ms, std::string& out_reason) {
    Init();
    if (ssid.empty()) {
        out_reason = "SSID 不能为空";
        return false;
    }
    if (mode_.load(std::memory_order_acquire) != Mode::AccessPoint) {
        out_reason = "TryConnect 必须在配网模式下调用";
        ESP_LOGE(wifi_internal::kTag, "TryConnect called without AP mode");
        return false;
    }
    want_reconnect_.store(false, std::memory_order_release);
    fail_count_.store(0, std::memory_order_release);
    last_disconnect_reason_.store(0, std::memory_order_release);
    StopSlowReconnect();

    wifi_config_t wc = {};
    if (!wifi_internal::FillStaConfig(wc, ssid, password, &out_reason))
        return false;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    constexpr int kMaxAttempts         = 3;
    constexpr int kPerAttemptTimeoutMs = 8000;
    const int     total_budget         = std::max(timeout_ms, kPerAttemptTimeoutMs);
    const int64_t deadline_ms          = time_utils::NowMs() + total_budget;

    int last_reason = 0;
    for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
        const int64_t now_ms      = time_utils::NowMs();
        const int     budget_left = static_cast<int>(deadline_ms - now_ms);
        if (budget_left <= 0)
            break;
        const int wait_ms = std::min(budget_left, kPerAttemptTimeoutMs);

        xEventGroupClearBits(wifi_internal::EventGroup(), wifi_internal::BIT_CONNECTED | wifi_internal::BIT_FAIL);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(wifi_internal::kTag, "ESP wifi_connect attempt %d failed: %s", attempt, esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(300));
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(wifi_internal::EventGroup(),
                                               wifi_internal::BIT_CONNECTED | wifi_internal::BIT_FAIL, pdFALSE, pdFALSE,
                                               pdMS_TO_TICKS(wait_ms));

        if (bits & wifi_internal::BIT_CONNECTED) {
            esp_wifi_disconnect();
            state_.store(State::Idle);
            xEventGroupClearBits(wifi_internal::EventGroup(), wifi_internal::BIT_CONNECTED | wifi_internal::BIT_FAIL);
            return true;
        }
        if (bits & wifi_internal::BIT_FAIL) {
            last_reason = last_disconnect_reason_.load(std::memory_order_acquire);
            ESP_LOGW(wifi_internal::kTag, "TryConnect attempt %d failed: reason=%d", attempt, last_reason);
            vTaskDelay(pdMS_TO_TICKS(300));
        } else {
            ESP_LOGW(wifi_internal::kTag, "TryConnect attempt %d timeout (%dms)", attempt, wait_ms);
            esp_wifi_disconnect();
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }

    if (last_reason != 0) {
        out_reason = wifi_internal::DisconnectReasonZh(last_reason);
    } else {
        out_reason = "连接超时,可能信号弱或路由器无响应";
    }
    esp_wifi_disconnect();
    ESP_LOGW(wifi_internal::kTag, "TryConnect all attempts failed: %s", out_reason.c_str());
    return false;
}

void Wifi::Disconnect() {
    want_reconnect_.store(false, std::memory_order_release);
    StopSlowReconnect();
    if (mode_.load(std::memory_order_acquire) == Mode::Station)
        esp_wifi_disconnect();
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
        ESP_LOGW(wifi_internal::kTag, "StartAp called but already in AP mode");
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
