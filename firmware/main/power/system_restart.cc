#include "power/system_restart.h"

#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "power/shutdown_subsystems.h"

namespace system_restart {

[[noreturn]] void GracefulRestart(int pre_delay_ms, int epd_timeout_ms) {
    if (pre_delay_ms > 0)
        vTaskDelay(pdMS_TO_TICKS(pre_delay_ms));

    system_shutdown::WaitForEpdAndShutdown(epd_timeout_ms);

    esp_restart();
    __builtin_unreachable();
}

}  // namespace system_restart
