#include <esp_log.h>

#include "app.h"

namespace {
constexpr char kTag[] = "Main";
}

extern "C" void app_main(void) {
    ESP_LOGI(kTag, "Firmware boot");
    static App app;
    app.Init();
    app.Run();
}
