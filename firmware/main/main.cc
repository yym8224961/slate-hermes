#include <esp_log.h>

#include "app.h"

namespace {
constexpr char kTag[] = "main";
}

extern "C" void app_main(void) {
    ESP_LOGI(kTag, "===== slate firmware boot =====");
    static App app;
    app.Init();
    app.Run();
}
