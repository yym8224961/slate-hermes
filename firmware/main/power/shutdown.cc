#include "power/shutdown.h"

#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "bsp/board.h"
#include "bsp/charge_status.h"
#include "drivers/audio/audio_player.h"
#include "drivers/display/epd_ssd1683.h"
#include "sync/sync_service.h"

namespace power_shutdown {

namespace {
PreShutdownHook s_pre_shutdown_hook = nullptr;
}

void SetPreShutdownHook(PreShutdownHook hook) {
    s_pre_shutdown_hook = hook;
}

bool WaitForEpdAndShutdown(int epd_timeout_ms) {
    if (s_pre_shutdown_hook)
        s_pre_shutdown_hook();
    SyncService::Get().Stop();
    AudioPlayer::Get().Stop();
    if (auto* charge = Board::Get().charge())
        charge->StopTick();

    auto* epd = Board::Get().epd();
    if (!epd)
        return true;

    int waited = 0;
    while (epd->IsRefreshPending() && waited < epd_timeout_ms) {
        vTaskDelay(pdMS_TO_TICKS(50));
        waited += 50;
    }
    return !epd->IsRefreshPending();
}

[[noreturn]] void GracefulRestart(int pre_delay_ms, int epd_timeout_ms) {
    if (pre_delay_ms > 0)
        vTaskDelay(pdMS_TO_TICKS(pre_delay_ms));

    WaitForEpdAndShutdown(epd_timeout_ms);

    esp_restart();
    __builtin_unreachable();
}

}  // namespace power_shutdown
