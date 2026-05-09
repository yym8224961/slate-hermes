#include "sntp.h"

#include <esp_log.h>
#include <esp_netif_sntp.h>
#include <esp_sntp.h>
#include <sdkconfig.h>

#include <ctime>
#include <cstdlib>

namespace {
constexpr char kTag[] = "Sntp";
}

namespace sntp {

void Init() {
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    cfg.start             = true;
    esp_netif_sntp_init(&cfg);

    setenv("TZ", CONFIG_SLATE_DEFAULT_TIMEZONE, 1);
    tzset();
    ESP_LOGI(kTag, "SNTP started, TZ=%s", CONFIG_SLATE_DEFAULT_TIMEZONE);
}

bool TimeSynced() {
    time_t now = time(nullptr);
    return now > 1577836800;  // 2020-01-01 之后视为同步过
}

}  // namespace sntp
