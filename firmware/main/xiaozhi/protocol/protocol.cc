#include "xiaozhi/protocol/protocol.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <cstdlib>
#include <cstring>
#include <mutex>

#include "events/event_bus.h"
#include "utils/json_utils.h"
#include "xiaozhi/config/settings.h"
#include "xiaozhi/mcp/mcp_dispatcher.h"
#include "xiaozhi/mcp/mcp_tools.h"
#include "xiaozhi/protocol/mqtt_protocol.h"
#include "xiaozhi/protocol/websocket_protocol.h"
#include "xiaozhi/service/xiaozhi_service.h"

namespace {
constexpr char kTag[]               = "xiaozhi_proto";
constexpr int  kMcpAudioReadyPollMs = 10;
constexpr int  kMcpAudioReadyWaitMs = 10000;

using json_utils::JsonStringLiteral;
}  // namespace

namespace xiaozhi {

Protocol::~Protocol() {
    StopMcpSendTask();
}

void Protocol::OnIncomingAudio(std::function<void(std::unique_ptr<AudioStreamPacket>)> cb) {
    on_incoming_audio_ = std::move(cb);
}

void Protocol::OnIncomingJson(std::function<void(const cJSON*)> cb) {
    on_incoming_json_ = std::move(cb);
}

void Protocol::OnAudioChannelOpened(std::function<void()> cb) {
    on_audio_channel_opened_ = std::move(cb);
}

void Protocol::OnAudioChannelClosed(std::function<void()> cb) {
    on_audio_channel_closed_ = std::move(cb);
}

void Protocol::OnNetworkError(std::function<void(const std::string&)> cb) {
    on_network_error_ = std::move(cb);
}

void Protocol::OnConnected(std::function<void()> cb) {
    on_connected_ = std::move(cb);
}

void Protocol::OnDisconnected(std::function<void()> cb) {
    on_disconnected_ = std::move(cb);
}

void Protocol::SetError(const std::string& message) {
    error_occurred_.store(true, std::memory_order_release);
    ESP_LOGW(kTag, "network error message=%s", message.c_str());
    if (on_network_error_) {
        on_network_error_(message);
    }
}

void Protocol::PrepareAudioChannelOpen() {
    audio_channel_close_requested_.store(false, std::memory_order_release);
}

void Protocol::MarkAudioChannelCloseRequested() {
    audio_channel_close_requested_.store(true, std::memory_order_release);
}

bool Protocol::IsAudioChannelCloseRequested() const {
    return audio_channel_close_requested_.load(std::memory_order_acquire);
}

void Protocol::PostChannelClosedEvent() const {
    evt::PostXiaozhiChannelClosed(owner_token_);
}

void Protocol::ClearSessionId() {
    std::lock_guard<std::mutex> lock(session_mutex_);
    session_id_.clear();
}

void Protocol::SetSessionId(const char* session_id) {
    std::lock_guard<std::mutex> lock(session_mutex_);
    session_id_ = session_id ? session_id : "";
}

std::string Protocol::SessionIdCopy() const {
    std::lock_guard<std::mutex> lock(session_mutex_);
    return session_id_;
}

void Protocol::SetServerAudioParams(int sample_rate, int frame_duration) {
    std::lock_guard<std::mutex> lock(incoming_mutex_);
    server_sample_rate_    = sample_rate;
    server_frame_duration_ = frame_duration;
}

void Protocol::GetServerAudioParams(int& sample_rate, int& frame_duration) const {
    std::lock_guard<std::mutex> lock(incoming_mutex_);
    sample_rate    = server_sample_rate_;
    frame_duration = server_frame_duration_;
}

void Protocol::MarkIncomingNow() {
    std::lock_guard<std::mutex> lock(incoming_mutex_);
    last_incoming_time_ = std::chrono::steady_clock::now();
}

void Protocol::ResetIncomingTimeout() {
    std::lock_guard<std::mutex> lock(incoming_mutex_);
    last_incoming_time_ = std::chrono::steady_clock::time_point::min();
}

void Protocol::SendStartListening(ListeningMode mode) {
    const std::string session_id = SessionIdCopy();
    std::string       message =
        "{\"session_id\":" + JsonStringLiteral(session_id) + ",\"type\":\"listen\",\"state\":\"start\",\"mode\":\"";
    message += (mode == ListeningMode::kManualStop) ? "manual" : "auto";
    message += "\"}";
    SendText(message);
}

void Protocol::SendStopListening() {
    const std::string session_id = SessionIdCopy();
    std::string       message =
        "{\"session_id\":" + JsonStringLiteral(session_id) + ",\"type\":\"listen\",\"state\":\"stop\"}";
    SendText(message);
}

void Protocol::SendAbortSpeaking(AbortReason reason) {
    const std::string session_id = SessionIdCopy();
    std::string       message    = "{\"session_id\":" + JsonStringLiteral(session_id) + ",\"type\":\"abort\"";
    if (reason == AbortReason::kWakeWordDetected) {
        message += ",\"reason\":\"wake_word_detected\"";
    }
    message += "}";
    SendText(message);
}

void Protocol::SendMcpMessage(const std::string& payload) {
    McpSendItem item{};
    item.data = static_cast<char*>(std::malloc(payload.size() + 1));
    if (!item.data) {
        ESP_LOGW(kTag, "mcp tx dropped reason=alloc_failed bytes=%u", static_cast<unsigned>(payload.size()));
        return;
    }
    std::memcpy(item.data, payload.data(), payload.size());
    item.data[payload.size()] = '\0';
    item.len                  = payload.size();

    std::lock_guard<std::mutex> lock(mcp_mutex_);
    if (!mcp_accepting_.load(std::memory_order_relaxed)) {
        std::free(item.data);
        return;
    }
    if (!StartMcpSendTaskLocked() || !mcp_send_queue_ ||
        xQueueSendToBack(mcp_send_queue_, &item, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(kTag, "mcp tx dropped reason=queue_unavailable_or_full bytes=%u",
                 static_cast<unsigned>(payload.size()));
        std::free(item.data);
        return;
    }
}

bool Protocol::StartMcpSendTaskLocked() {
    if (mcp_send_queue_ && mcp_send_task_)
        return true;
    if (!mcp_send_queue_) {
        mcp_send_queue_ = xQueueCreate(4, sizeof(McpSendItem));
        if (!mcp_send_queue_) {
            ESP_LOGW(kTag, "mcp send queue create failed");
            return false;
        }
    }
    if (!mcp_send_task_) {
        const BaseType_t ok =
            xTaskCreatePinnedToCore(&Protocol::McpSendTaskEntry, "xiaozhi_mcp_tx", 4096, this, 3, &mcp_send_task_, 0);
        if (ok != pdPASS) {
            ESP_LOGW(kTag, "mcp send task create failed");
            vQueueDelete(mcp_send_queue_);
            mcp_send_queue_ = nullptr;
            return false;
        }
    }
    return true;
}

void Protocol::StopMcpSendTask() {
    TaskHandle_t  task  = nullptr;
    QueueHandle_t queue = nullptr;
    {
        std::lock_guard<std::mutex> lock(mcp_mutex_);
        mcp_accepting_.store(false, std::memory_order_relaxed);
        task  = mcp_send_task_;
        queue = mcp_send_queue_;
        if (task)
            mcp_stop_waiter_ = xTaskGetCurrentTaskHandle();
    }

    if (task) {
        McpSendItem sentinel{};
        sentinel.stop      = true;
        bool sentinel_sent = false;
        if (queue) {
            for (int attempt = 0; attempt < 2 && !sentinel_sent; ++attempt) {
                sentinel_sent = xQueueSendToBack(queue, &sentinel, pdMS_TO_TICKS(100)) == pdTRUE;
                if (!sentinel_sent) {
                    McpSendItem dropped{};
                    if (xQueueReceive(queue, &dropped, 0) == pdTRUE)
                        std::free(dropped.data);
                }
            }
        }
        if (sentinel_sent) {
            if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000)) == 0) {
                ESP_LOGW(kTag, "mcp send task stop timeout");
            }
        } else {
            ESP_LOGW(kTag, "mcp send task stop failed reason=sentinel_queue_failed");
        }
    }

    {
        std::lock_guard<std::mutex> lock(mcp_mutex_);
        mcp_stop_waiter_ = nullptr;
        if (mcp_send_task_) {
            ESP_LOGW(kTag, "mcp send task stop incomplete action=keep_queue_alive");
            return;
        }
        queue           = mcp_send_queue_;
        mcp_send_queue_ = nullptr;
    }

    if (queue) {
        McpSendItem queued{};
        while (xQueueReceive(queue, &queued, 0) == pdTRUE) {
            std::free(queued.data);
        }
        vQueueDelete(queue);
    }
}

void Protocol::McpSendTaskEntry(void* arg) {
    static_cast<Protocol*>(arg)->McpSendTask();
}

void Protocol::McpSendTask() {
    QueueHandle_t queue = nullptr;
    {
        std::lock_guard<std::mutex> lock(mcp_mutex_);
        queue = mcp_send_queue_;
    }
    if (!queue) {
        vTaskDelete(nullptr);
        return;
    }

    while (true) {
        McpSendItem item{};
        if (xQueueReceive(queue, &item, portMAX_DELAY) != pdTRUE)
            continue;
        if (item.stop) {
            TaskHandle_t waiter = nullptr;
            {
                std::lock_guard<std::mutex> lock(mcp_mutex_);
                waiter = mcp_stop_waiter_;
                if (mcp_send_task_ == xTaskGetCurrentTaskHandle())
                    mcp_send_task_ = nullptr;
            }
            if (waiter)
                xTaskNotifyGive(waiter);
            vTaskDelete(nullptr);
            return;
        }

        int waited_ms = 0;
        while (mcp_accepting_.load(std::memory_order_acquire) &&
               !audio_channel_ready_.load(std::memory_order_acquire) && waited_ms < kMcpAudioReadyWaitMs) {
            vTaskDelay(pdMS_TO_TICKS(kMcpAudioReadyPollMs));
            waited_ms += kMcpAudioReadyPollMs;
        }

        const std::string session_id = SessionIdCopy();
        if (!mcp_accepting_.load(std::memory_order_acquire) || !audio_channel_ready_.load(std::memory_order_acquire) ||
            session_id.empty()) {
            if (mcp_accepting_.load(std::memory_order_acquire) &&
                !audio_channel_ready_.load(std::memory_order_acquire)) {
                ESP_LOGW(kTag, "mcp tx dropped reason=audio_channel_not_ready elapsed_ms=%d", waited_ms);
            }
            std::free(item.data);
            continue;
        }

        std::string payload(item.data ? item.data : "", item.len);
        std::string message =
            "{\"session_id\":" + JsonStringLiteral(session_id) + ",\"type\":\"mcp\",\"payload\":" + payload + "}";
        SendText(message);
        std::free(item.data);
    }
}

bool Protocol::HandleMcpMessage(const cJSON* root) {
    if (!mcp_accepting_.load(std::memory_order_relaxed)) {
        return true;
    }

    mcp::Dispatcher dispatcher{
        [this](const std::string& payload) { SendMcpMessage(payload); },
        [] { return mcp::BuildDeviceStatusJson(); },
        [](int level) { XiaozhiService::Get().SetVolume(level); },
    };
    return mcp::DispatchMessage(root, dispatcher);
}

bool Protocol::IsTimeout() const {
    constexpr int               kTimeoutSeconds = 120;
    std::lock_guard<std::mutex> lock(incoming_mutex_);
    if (last_incoming_time_ == std::chrono::steady_clock::time_point::min())
        return false;
    const auto now  = std::chrono::steady_clock::now();
    const auto diff = std::chrono::duration_cast<std::chrono::seconds>(now - last_incoming_time_);
    return diff.count() > kTimeoutSeconds;
}

std::unique_ptr<Protocol> CreatePreferredProtocol() {
    settings::MqttConfig mqtt;
    if (settings::LoadMqtt(mqtt)) {
        return std::make_unique<MqttProtocol>();
    }
    settings::WebsocketConfig ws;
    if (settings::LoadWebsocket(ws)) {
        return std::make_unique<WebsocketProtocol>();
    }
    return nullptr;
}

}  // namespace xiaozhi
