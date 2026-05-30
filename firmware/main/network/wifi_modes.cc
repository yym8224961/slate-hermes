#include "network/wifi.h"

#include <esp_log.h>
#include <esp_mac.h>

#include <cstdio>
#include <cstring>

#include "network/wifi_internal.h"

void Wifi::StartStationInternal() {
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

void Wifi::StartApInternal(const std::string& ssid_prefix) {
    if (mode_.load(std::memory_order_acquire) == Mode::Station)
        StopStationInternal();

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
