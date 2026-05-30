#include "xiaozhi/service/chat_service.h"

#include <esp_heap_caps.h>
#include <esp_log.h>

#include "xiaozhi/api/activation_client.h"
#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

void ChatService::StartConfigTask() {
    if (!started_.load(std::memory_order_relaxed) || config_running_.exchange(true))
        return;
    std::lock_guard<std::mutex> task_lock(config_task_mutex_);
    if (tasks_.config_task) {
        config_running_.store(false, std::memory_order_relaxed);
        ESP_LOGW(kTag, "Config task is still stopping");
        return;
    }
    config_stop_requested_.store(false, std::memory_order_relaxed);
    if (tasks_.config_done_notify) {
        while (xSemaphoreTake(tasks_.config_done_notify, 0) == pdTRUE) {
        }
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ConfigTaskEntry, "xiaozhi_cfg", 8 * 1024, this, 3,
                                            &tasks_.config_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Config task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        config_running_.store(false, std::memory_order_relaxed);
        tasks_.config_task = nullptr;
        if (tasks_.config_done_notify)
            xSemaphoreGive(tasks_.config_done_notify);
        SetError("小智配置任务启动失败");
    }
}

void ChatService::StopConfigTask(bool wait) {
    config_stop_requested_.store(true, std::memory_order_relaxed);
    if (!wait || !config_running_.load(std::memory_order_relaxed))
        return;
    if (!tasks_.config_done_notify)
        return;
    if (xSemaphoreTake(tasks_.config_done_notify, pdMS_TO_TICKS(2000)) != pdTRUE) {
        ESP_LOGW(kTag, "Timed out waiting for config task");
    }
}

void ChatService::SignalConfigTaskStopped() {
    if (tasks_.config_done_notify)
        xSemaphoreGive(tasks_.config_done_notify);
}

void ChatService::ConfigTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ConfigTask();
    bool signal_stopped = false;
    {
        std::lock_guard<std::mutex> task_lock(self->config_task_mutex_);
        if (self->tasks_.config_task == xTaskGetCurrentTaskHandle()) {
            self->tasks_.config_task = nullptr;
            signal_stopped           = true;
        }
    }
    self->config_running_.store(false, std::memory_order_relaxed);
    if (signal_stopped)
        self->SignalConfigTaskStopped();
    vTaskDelete(nullptr);
}

void ChatService::ConfigTask() {
    while (in_mode_.load(std::memory_order_relaxed) && !config_stop_requested_.load(std::memory_order_relaxed) &&
           !settings::HasProtocolConfig()) {
        SetState(ChatState::kCheckingConfig, "获取小智配置中...");
        ActivationClient  client;
        ActivationConfigResult result = client.Fetch();
        if (config_stop_requested_.load(std::memory_order_relaxed) || !in_mode_.load(std::memory_order_relaxed))
            return;
        {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.has_protocol = settings::HasProtocolConfig() || result.has_protocol;
        }

        if (result.has_protocol || settings::HasProtocolConfig()) {
            SetState(ChatState::kReadyIdle, "小智待机");
            return;
        }
        if (result.has_activation_challenge) {
            if (!result.activation_code.empty())
                SetActivation(result.activation_message, result.activation_code);
            esp_err_t activate_err = client.Activate(result.activation_challenge);
            if (activate_err != ESP_OK && activate_err != ESP_ERR_TIMEOUT)
                ESP_LOGW(kTag, "Activation challenge failed: %s", esp_err_to_name(activate_err));
        }
        if (result.has_activation) {
            SetActivation(result.activation_message, result.activation_code);
        } else if (!result.ok) {
            SetError(result.error.empty() ? "小智配置失败" : result.error);
        } else if (result.has_activation_challenge) {
            SetState(ChatState::kCheckingConfig, "小智激活确认中...");
        } else {
            SetError("小智未返回协议配置");
        }

        const int delay_steps = result.has_activation ? 30 : 100;
        for (int i = 0; i < delay_steps && in_mode_.load(std::memory_order_relaxed) &&
                        !config_stop_requested_.load(std::memory_order_relaxed) && !settings::HasProtocolConfig();
             ++i)
            vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (in_mode_.load(std::memory_order_relaxed) && !config_stop_requested_.load(std::memory_order_relaxed) &&
        settings::HasProtocolConfig())
        SetState(ChatState::kReadyIdle, "小智待机");
}

}  // namespace xiaozhi
