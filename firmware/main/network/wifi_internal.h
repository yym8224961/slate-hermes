#pragma once

#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#include <string>

namespace wifi_internal {

inline constexpr char kTag[]        = "Wifi";
inline constexpr int  BIT_CONNECTED = BIT0;
inline constexpr int  BIT_FAIL      = BIT1;

EventGroupHandle_t& EventGroup();
void                EnsureEventGroup();

bool        FillStaConfig(wifi_config_t& wc, const std::string& ssid, const std::string& password, std::string* reason);
std::string DisconnectReasonZh(int reason);
bool        SsidEquals(const uint8_t lhs[32], const uint8_t rhs[32]);

}  // namespace wifi_internal
