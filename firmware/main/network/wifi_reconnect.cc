#include "network/wifi.h"

#include <esp_log.h>
#include <esp_timer.h>

#include <algorithm>
#include <array>
#include <cstring>

#include "network/wifi_internal.h"

namespace {
constexpr uint32_t kBackoffSec[]       = {10, 20, 40, 80, 120, 120};
constexpr size_t   kBackoffSize        = sizeof(kBackoffSec) / sizeof(kBackoffSec[0]);
constexpr uint16_t kMaxSlowScanRecords = 20;
}  // namespace

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
    if (!want_reconnect_.load(std::memory_order_acquire))
        return;
    EnsureReconnectTimer();
    const size_t   idx     = std::min(backoff_idx_.load(std::memory_order_acquire), kBackoffSize - 1);
    const uint32_t seconds = kBackoffSec[idx];
    esp_timer_stop(reconnect_timer_);
    ESP_ERROR_CHECK(esp_timer_start_once(reconnect_timer_, static_cast<uint64_t>(seconds) * 1000ULL * 1000ULL));
    if (idx < kBackoffSize - 1)
        backoff_idx_.store(idx + 1, std::memory_order_release);
}

void Wifi::StopSlowReconnect() {
    if (reconnect_timer_) {
        esp_err_t err = esp_timer_stop(reconnect_timer_);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(wifi_internal::kTag, "esp_timer_stop failed: %s", esp_err_to_name(err));
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
    fail_count_.store(0, std::memory_order_release);
    state_.store(State::Connecting);
    slow_scan_pending_.store(true, std::memory_order_release);

    wifi_scan_config_t scan_cfg   = {};
    scan_cfg.ssid                 = nullptr;
    scan_cfg.bssid                = nullptr;
    scan_cfg.channel              = 0;
    scan_cfg.show_hidden          = true;
    scan_cfg.scan_type            = WIFI_SCAN_TYPE_ACTIVE;
    scan_cfg.scan_time.active.min = 0;
    scan_cfg.scan_time.active.max = 120;

    esp_err_t err = esp_wifi_scan_start(&scan_cfg, false);
    if (err != ESP_OK) {
        ESP_LOGW(wifi_internal::kTag, "ESP wifi_scan_start failed: %s, reschedule", esp_err_to_name(err));
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

    wifi_config_t wc = {};
    if (esp_wifi_get_config(WIFI_IF_STA, &wc) != ESP_OK) {
        ESP_LOGW(wifi_internal::kTag, "ESP wifi_get_config failed in slow scan handler");
        ScheduleSlowReconnect();
        return;
    }
    if (wc.sta.ssid[0] == '\0') {
        ESP_LOGW(wifi_internal::kTag, "Slow scan: no target SSID in current config, abort");
        return;
    }
    const wifi_ap_record_t* match = nullptr;
    for (uint16_t i = 0; i < ap_num; ++i) {
        if (wifi_internal::SsidEquals(records[i].ssid, wc.sta.ssid)) {
            match = &records[i];
            break;
        }
    }

    if (!match) {
        ScheduleSlowReconnect();
        return;
    }

    wc.sta.bssid_set = 1;
    std::memcpy(wc.sta.bssid, match->bssid, 6);
    wc.sta.channel = match->primary;
    esp_wifi_set_config(WIFI_IF_STA, &wc);

    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(wifi_internal::kTag, "ESP wifi_connect after slow scan failed: %s", esp_err_to_name(err));
        ScheduleSlowReconnect();
    }
}
