#include "xiaozhi/service/chat_service.h"

#include <esp_heap_caps.h>
#include <esp_log.h>

#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

void ChatService::StartControlTask() {
    if (tasks_.control_task || control_running_.exchange(true))
        return;
    if (!tasks_.control_notify)
        tasks_.control_notify = xSemaphoreCreateBinary();
    if (!tasks_.control_notify) {
        ESP_LOGE(kTag, "Control semaphore create failed");
        control_running_.store(false, std::memory_order_relaxed);
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ControlTaskEntry, "xiaozhi_ctl", 4 * 1024, this, 3,
                                            &tasks_.control_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Control task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        tasks_.control_task = nullptr;
        control_running_.store(false, std::memory_order_relaxed);
    }
}

void ChatService::RequestControlClose(uint32_t conversation_token) {
    if (conversation_token != conversation_token_.load(std::memory_order_acquire))
        return;
    ESP_LOGI(kTag, "RequestControlClose token=%lu", static_cast<unsigned long>(conversation_token));
    control_close_token_.store(conversation_token, std::memory_order_release);
    control_close_requested_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void ChatService::RequestConversationStoppedHandling() {
    ESP_LOGI(kTag, "RequestConversationStoppedHandling");
    control_conversation_stopped_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void ChatService::MaybeStartPendingConversation() {
    control_close_requested_.store(false, std::memory_order_relaxed);
    if (!in_mode_.load(std::memory_order_relaxed)) {
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        return;
    }
    if (!settings::HasProtocolConfig()) {
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        if (CurrentState() != ChatState::kError)
            StartConfigTask();
        return;
    }
    if (chat_phase_.load(std::memory_order_relaxed) == ChatPhase::kStartPending) {
        ESP_LOGI(kTag, "MaybeStartPendingConversation starting queued conversation");
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        StartConversationTask();
        return;
    }
    chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
    if (CurrentState() != ChatState::kError)
        SetState(ChatState::kReadyIdle, "小智待机");
}

void ChatService::ControlTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ControlTask();
    self->tasks_.control_task = nullptr;
    self->control_running_.store(false, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

void ChatService::ControlTask() {
    while (control_running_.load(std::memory_order_relaxed)) {
        if (!tasks_.control_notify) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        xSemaphoreTake(tasks_.control_notify, portMAX_DELAY);
        if (control_close_requested_.exchange(false, std::memory_order_acq_rel)) {
            const uint32_t token = control_close_token_.load(std::memory_order_acquire);
            ESP_LOGI(kTag, "ControlTask close request token=%lu current=%lu", static_cast<unsigned long>(token),
                     static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
            if (token == conversation_token_.load(std::memory_order_acquire))
                StopConversation(false);
        }
        if (control_conversation_stopped_.exchange(false, std::memory_order_acq_rel)) {
            ESP_LOGI(kTag, "ControlTask conversation stopped");
            MaybeStartPendingConversation();
        }
    }
}

}  // namespace xiaozhi
