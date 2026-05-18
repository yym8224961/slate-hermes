#include "poll_interval_store.h"

#include <esp_log.h>
#include <nvs.h>

namespace {
constexpr char kTag[] = "PollInt";
constexpr char kNs[]  = "slate";
constexpr char kKey[] = "poll_sec";
}  // namespace

namespace poll {

int Get() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return kDefault;
    int32_t v = 0;
    esp_err_t err = nvs_get_i32(h, kKey, &v);
    nvs_close(h);
    if (err != ESP_OK || v < kMin || v > kMax) return kDefault;
    return static_cast<int>(v);
}

void Set(int seconds) {
    if (seconds < kMin) seconds = kMin;
    if (seconds > kMax) seconds = kMax;
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "NVS open failed");
        return;
    }
    esp_err_t err = nvs_set_i32(h, kKey, static_cast<int32_t>(seconds));
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "nvs_set_i32 failed: %s", esp_err_to_name(err));
        nvs_close(h);
        return;
    }
    err = nvs_commit(h);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "nvs_commit failed: %s", esp_err_to_name(err));
    }
    nvs_close(h);
}

}  // namespace poll
