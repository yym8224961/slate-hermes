#include "event_bus.h"

#include <esp_log.h>

namespace {
constexpr char        kTag[]    = "Event";
QueueHandle_t         s_queue   = nullptr;
constexpr UBaseType_t kQueueLen = 64;
}  // namespace

namespace evt {

void Init() {
    if (s_queue)
        return;
    s_queue = xQueueCreate(kQueueLen, sizeof(UiEvent));
    configASSERT(s_queue);
}

bool Post(const UiEvent& e, TickType_t timeout) {
    if (!s_queue) {
        ESP_LOGW(kTag, "Post before Init, dropped kind=%d", static_cast<int>(e.kind));
        return false;
    }
    if (xQueueSendToBack(s_queue, &e, timeout) != pdTRUE) {
        ESP_LOGW(kTag, "Queue full, dropped kind=%d", static_cast<int>(e.kind));
        return false;
    }
    return true;
}

bool PostFromIsr(const UiEvent& e, BaseType_t* hpw) {
    if (!s_queue)
        return false;
    return xQueueSendToBackFromISR(s_queue, &e, hpw) == pdTRUE;
}

bool Wait(UiEvent* out, TickType_t timeout) {
    if (!s_queue || !out)
        return false;
    return xQueueReceive(s_queue, out, timeout) == pdTRUE;
}

}  // namespace evt
