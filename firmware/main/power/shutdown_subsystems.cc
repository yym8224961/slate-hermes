#include "power/shutdown_subsystems.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "drivers/audio/audio_player.h"
#include "bsp/board.h"
#include "drivers/display/epd_ssd1683.h"
#include "sync/sync_service.h"

namespace system_shutdown {

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

}  // namespace system_shutdown
