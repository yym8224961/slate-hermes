#include "cred_store.h"

#include <esp_log.h>

#include "nvs_schema.h"
#include "nvs_store.h"

namespace {
constexpr char kTag[] = "Cred";
}  // namespace

namespace cred {

bool Load(Credentials& out) {
    nvs_store::GetStrings(nvs_schema::kNet, {
                                                {nvs_schema::net::kSsid, &out.wifi_ssid},
                                                {nvs_schema::net::kPwd, &out.wifi_pwd},
                                                {nvs_schema::net::kUrl, &out.server_url},
                                                {nvs_schema::net::kDevId, &out.device_id},
                                                {nvs_schema::net::kDevSec, &out.device_secret},
                                            });
    return !out.wifi_ssid.empty() && !out.server_url.empty();
}

bool Save(const Credentials& c) {
    bool ok = nvs_store::SetStrings(nvs_schema::kNet, {
                                                          {nvs_schema::net::kSsid, c.wifi_ssid},
                                                          {nvs_schema::net::kPwd, c.wifi_pwd},
                                                          {nvs_schema::net::kUrl, c.server_url},
                                                      });
    if (!ok) {
        ESP_LOGE(kTag, "Save credentials failed");
    }
    return ok;
}

bool SaveSecret(const std::string& device_id, const std::string& device_secret) {
    bool ok = nvs_store::SetStrings(nvs_schema::kNet, {
                                                          {nvs_schema::net::kDevId, device_id},
                                                          {nvs_schema::net::kDevSec, device_secret},
                                                      });
    if (!ok) {
        ESP_LOGE(kTag, "SaveSecret failed");
        return false;
    }
    return true;
}

void ClearSecret() {
    // 保留 Wi-Fi 和 server url，只清内容服务端设备身份。
    nvs_store::EraseKey(nvs_schema::kNet, nvs_schema::net::kDevId);
    nvs_store::EraseKey(nvs_schema::kNet, nvs_schema::net::kDevSec);
    ESP_LOGW(kTag, "Device secret cleared (will re-register on next boot)");
}

std::string GetServerUrl() {
    return nvs_store::GetString(nvs_schema::kNet, nvs_schema::net::kUrl);
}

void Clear() {
    nvs_store::EraseNamespace(nvs_schema::kNet);
    // 不读旧 namespace，但恢复出厂时顺手清掉测试残留。
    nvs_store::EraseNamespace(nvs_schema::kLegacy);
}

}  // namespace cred
