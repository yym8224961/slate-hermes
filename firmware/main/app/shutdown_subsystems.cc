#include "shutdown_subsystems.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "audio_player.h"
#include "board.h"
#include "epd_ssd1683.h"
#include "sync_service.h"
#include "xiaozhi_chat_service.h"

namespace app {

bool ShutdownSubsystems(int epd_wait_ms) {
    xiaozhi::ChatService::Get().SuspendForSleep();
    SyncService::Get().Stop();
    AudioPlayer::Get().Stop();

    auto* epd = Board::Get().epd();
    if (!epd)
        return true;

    int waited = 0;
    while (epd->IsRefreshPending() && waited < epd_wait_ms) {
        vTaskDelay(pdMS_TO_TICKS(50));
        waited += 50;
    }
    return !epd->IsRefreshPending();
}

}  // namespace app
