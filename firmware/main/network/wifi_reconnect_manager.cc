#include "network/wifi_reconnect_manager.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <esp_wifi.h>

#include <algorithm>
#include <array>
#include <cstring>

#include "network/wifi.h"

namespace {
constexpr char     kTag[]              = "Wifi";
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
}  // namespace

WifiReconnectManager::WifiReconnectManager(Wifi* owner) : owner_(owner) {
}

WifiReconnectManager::~WifiReconnectManager() {
    Stop();
    if (timer_) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_timer_delete(timer_));
        timer_ = nullptr;
    }
}

void WifiReconnectManager::ResetBackoff() {
    backoff_idx_.store(0, std::memory_order_release);
}

void WifiReconnectManager::EnsureTimer() {
    if (timer_)
        return;
    const esp_timer_create_args_t args = {
        .callback              = &OnTimer,
        .arg                   = this,
        .dispatch_method       = ESP_TIMER_TASK,
        .name                  = "wifi_slow_rc",
        .skip_unhandled_events = true,
    };
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer_));
}

void WifiReconnectManager::Schedule() {
    if (!owner_ || !owner_->ReconnectAllowed())
        return;
    EnsureTimer();
    const size_t   idx     = std::min(backoff_idx_.load(std::memory_order_acquire), kBackoffSize - 1);
    const uint32_t seconds = kBackoffSec[idx];
    esp_timer_stop(timer_);
    ESP_ERROR_CHECK(esp_timer_start_once(timer_, static_cast<uint64_t>(seconds) * 1000ULL * 1000ULL));
    if (idx < kBackoffSize - 1)
        backoff_idx_.store(idx + 1, std::memory_order_release);
}

void WifiReconnectManager::Stop() {
    if (timer_) {
        esp_err_t err = esp_timer_stop(timer_);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(kTag, "esp_timer_stop failed: %s", esp_err_to_name(err));
        }
    }
    slow_scan_pending_.store(false, std::memory_order_release);
}

bool WifiReconnectManager::ConsumeSlowScanPending() {
    return slow_scan_pending_.exchange(false, std::memory_order_acq_rel);
}

void WifiReconnectManager::OnTimer(void* arg) {
    auto* self = static_cast<WifiReconnectManager*>(arg);
    if (!self->owner_ || !self->owner_->ReconnectAllowed() || !self->owner_->StationModeActive())
        return;
    self->DoSlowScanReconnect();
}

void WifiReconnectManager::DoSlowScanReconnect() {
    if (!owner_)
        return;
    owner_->ResetFastFailCount();
    owner_->MarkSlowReconnectConnecting();
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
        ESP_LOGW(kTag, "ESP wifi_scan_start failed: %s, reschedule", esp_err_to_name(err));
        slow_scan_pending_.store(false, std::memory_order_release);
        Schedule();
    }
}

void WifiReconnectManager::HandleSlowScanResult() {
    uint16_t ap_num = 0;
    esp_wifi_scan_get_ap_num(&ap_num);
    if (ap_num == 0) {
        Schedule();
        return;
    }
    ap_num = std::min<uint16_t>(ap_num, kMaxSlowScanRecords);
    std::array<wifi_ap_record_t, kMaxSlowScanRecords> records{};
    esp_wifi_scan_get_ap_records(&ap_num, records.data());
    std::sort(records.begin(), records.begin() + ap_num,
              [](const wifi_ap_record_t& a, const wifi_ap_record_t& b) { return a.rssi > b.rssi; });

    wifi_config_t wc = {};
    if (esp_wifi_get_config(WIFI_IF_STA, &wc) != ESP_OK) {
        ESP_LOGW(kTag, "ESP wifi_get_config failed in slow scan handler");
        Schedule();
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
        Schedule();
        return;
    }

    wc.sta.bssid_set = 1;
    std::memcpy(wc.sta.bssid, match->bssid, 6);
    wc.sta.channel = match->primary;
    esp_wifi_set_config(WIFI_IF_STA, &wc);

    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "ESP wifi_connect after slow scan failed: %s", esp_err_to_name(err));
        Schedule();
    }
}
