#include "volume_store.h"

#include <esp_log.h>
#include <nvs.h>

namespace {
constexpr char kTag[] = "Volume";
constexpr char kNs[]  = "slate";
constexpr char kKey[] = "volume";
}  // namespace

namespace vol {

int Get() {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return kDefault;
    int8_t v = -1;
    esp_err_t err = nvs_get_i8(h, kKey, &v);
    nvs_close(h);
    if (err != ESP_OK || v < 0 || v > kMax) return kDefault;
    return v;
}

void Set(int level) {
    if (level < 0) level = 0;
    if (level > kMax) level = kMax;
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "NVS open failed");
        return;
    }
    nvs_set_i8(h, kKey, static_cast<int8_t>(level));
    nvs_commit(h);
    nvs_close(h);
}

int ToCodec(int level) {
    if (level < 0) return 0;
    if (level > kMax) level = kMax;
    return level * 10;
}

}  // namespace vol
