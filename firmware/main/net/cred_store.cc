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
    ReadStr(h, "device_id", out.device_id);
    ReadStr(h, "device_secret", out.device_secret);
    nvs_close(h);
    return ok && !out.wifi_ssid.empty();
}

bool Save(const Credentials& c) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_set_str(h, "wifi_ssid", c.wifi_ssid.c_str());
    nvs_set_str(h, "wifi_pwd", c.wifi_pwd.c_str());
    nvs_set_str(h, "server_url", c.server_url.c_str());
    esp_err_t e = nvs_commit(h);
    nvs_close(h);
    return e == ESP_OK;
}

bool SaveSecret(const std::string& device_id, const std::string& device_secret) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(kTag, "SaveSecret: nvs_open RW failed");
        return false;
    }
    esp_err_t e1 = nvs_set_str(h, "device_id", device_id.c_str());
    esp_err_t e2 = nvs_set_str(h, "device_secret", device_secret.c_str());
    esp_err_t ec = nvs_commit(h);
    nvs_close(h);
    if (e1 != ESP_OK || e2 != ESP_OK || ec != ESP_OK) {
        ESP_LOGE(kTag, "SaveSecret: set/commit failed (e1=%d e2=%d ec=%d)", e1, e2, ec);
        return false;
    }
    ESP_LOGI(kTag, "device_secret committed (id=%s)", device_id.c_str());
    return true;
}

void ClearSecret() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_key(h, "device_id");
    nvs_erase_key(h, "device_secret");
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGW(kTag, "device_secret cleared (will re-register on next boot)");
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
