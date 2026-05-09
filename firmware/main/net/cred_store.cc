#include "cred_store.h"

#include <esp_log.h>
#include <nvs.h>
#include <nvs_flash.h>

#include <cstring>

namespace {
constexpr char kTag[] = "Cred";
constexpr char kNs[]  = "slate";
}  // namespace

namespace cred {

static bool ReadStr(nvs_handle_t h, const char* key, std::string& out) {
    size_t    len = 0;
    esp_err_t e   = nvs_get_str(h, key, nullptr, &len);
    if (e != ESP_OK || len == 0) return false;
    char* buf = static_cast<char*>(malloc(len));
    if (!buf) return false;
    if (nvs_get_str(h, key, buf, &len) != ESP_OK) {
        free(buf);
        return false;
    }
    out.assign(buf, len > 0 ? len - 1 : 0);
    free(buf);
    return true;
}

bool Load(Credentials& out) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return false;
    bool ok = ReadStr(h, "wifi_ssid", out.wifi_ssid);
    ReadStr(h, "wifi_pwd", out.wifi_pwd);
    ReadStr(h, "server_url", out.server_url);
    ReadStr(h, "device_name", out.device_name);
    nvs_close(h);
    return ok && !out.wifi_ssid.empty();
}

bool Save(const Credentials& c) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_set_str(h, "wifi_ssid", c.wifi_ssid.c_str());
    nvs_set_str(h, "wifi_pwd", c.wifi_pwd.c_str());
    nvs_set_str(h, "server_url", c.server_url.c_str());
    if (!c.device_name.empty()) nvs_set_str(h, "device_name", c.device_name.c_str());
    esp_err_t e = nvs_commit(h);
    nvs_close(h);
    return e == ESP_OK;
}

std::string GetServerUrl() {
    Credentials c;
    Load(c);
    return c.server_url;
}

void Clear() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(kTag, "credentials cleared");
}

}  // namespace cred
