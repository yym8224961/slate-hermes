#pragma once

#include <esp_mac.h>

#include <cstdio>
#include <string>

namespace util {

enum class MacStringCase {
    kLower,
    kUpper,
};

inline std::string WifiStaMacString(MacStringCase letter_case = MacStringCase::kLower) {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char        buf[18];
    const char* fmt =
        letter_case == MacStringCase::kUpper ? "%02X:%02X:%02X:%02X:%02X:%02X" : "%02x:%02x:%02x:%02x:%02x:%02x";
    std::snprintf(buf, sizeof(buf), fmt, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return buf;
}

}  // namespace util
