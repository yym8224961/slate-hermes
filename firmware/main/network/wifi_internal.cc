#include "network/wifi_internal.h"

#include <freertos/FreeRTOS.h>

#include <cstdio>
#include <cstring>

namespace wifi_internal {

EventGroupHandle_t& EventGroup() {
    static EventGroupHandle_t s_event_group = nullptr;
    return s_event_group;
}

void EnsureEventGroup() {
    auto& event_group = EventGroup();
    if (!event_group)
        event_group = xEventGroupCreate();
    configASSERT(event_group != nullptr);
}

namespace {
size_t BoundedSsidLen(const uint8_t ssid[32]) {
    size_t len = 0;
    while (len < 32 && ssid[len] != 0)
        ++len;
    return len;
}
}  // namespace

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
    if (!password.empty() && password.size() < 8) {
        if (reason)
            *reason = "Wi-Fi 密码至少 8 位；开放网络请留空";
        return false;
    }
    std::memcpy(wc.sta.ssid, ssid.data(), ssid.size());
    std::memcpy(wc.sta.password, password.data(), password.size());
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable    = true;
    wc.sta.pmf_cfg.required   = false;
    return true;
}

std::string DisconnectReasonZh(int reason) {
    switch (reason) {
        case 1:
            return "未指定原因";
        case 2:
            return "auth 失败";
        case 3:
            return "路由器主动断开(auth)";
        case 4:
            return "associate 超时";
        case 5:
            return "AP 客户端过多";
        case 6:
            return "未认证";
        case 7:
            return "未关联";
        case 8:
            return "本机断开(assoc-leave,常见于配置切换)";
        case 14:
            return "MIC 失败,密码错";
        case 15:
            return "4-way handshake 超时(密码错)";
        case 200:
            return "信号弱或路由器无 beacon";
        case 201:
            return "未找到该 SSID";
        case 202:
            return "认证失败,密码错";
        case 203:
            return "associate 失败";
        case 204:
            return "握手超时";
        case 205:
            return "连接失败";
        default: {
            char buf[48];
            std::snprintf(buf, sizeof(buf), "连接失败 (reason=%d)", reason);
            return buf;
        }
    }
}

}  // namespace wifi_internal
