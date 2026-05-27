#include "xiaozhi_protocol.h"

#include <algorithm>
#include <esp_app_desc.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <new>

#include "board.h"
#include "charge_status.h"
#include "volume_store.h"
#include "wifi.h"
#include "xiaozhi_audio_service.h"
#include "xiaozhi_chat_service.h"
#include "xiaozhi_mqtt_protocol.h"
#include "xiaozhi_settings.h"
#include "xiaozhi_websocket_protocol.h"

namespace {
constexpr char kTag[] = "XiaoProto";

std::string JsonString(const cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}

std::string JsonId(const cJSON* id) {
    if (cJSON_IsNumber(id))
        return std::to_string(id->valueint);
    if (cJSON_IsString(id) && id->valuestring) {
        cJSON* str = cJSON_CreateString(id->valuestring);
        char* raw = cJSON_PrintUnformatted(str);
        std::string out(raw ? raw : "\"\"");
        cJSON_free(raw);
        cJSON_Delete(str);
        return out;
    }
    return "";
}

std::string PrintAndDelete(cJSON* root) {
    char* raw = cJSON_PrintUnformatted(root);
    std::string out(raw ? raw : "{}");
    cJSON_free(raw);
    cJSON_Delete(root);
    return out;
}

std::string ChatStateName(xiaozhi::ChatState state) {
    switch (state) {
        case xiaozhi::ChatState::kCheckingConfig:
            return "checking_config";
        case xiaozhi::ChatState::kAwaitingActivation:
            return "awaiting_activation";
        case xiaozhi::ChatState::kReadyIdle:
            return "ready_idle";
        case xiaozhi::ChatState::kConnecting:
            return "connecting";
        case xiaozhi::ChatState::kListening:
            return "listening";
        case xiaozhi::ChatState::kSpeaking:
            return "speaking";
        case xiaozhi::ChatState::kError:
            return "error";
    }
    return "unknown";
}

std::string ChargeStateName(ChargeStatus::State state) {
    switch (state) {
        case ChargeStatus::State::kNoPower:
            return "no_power";
        case ChargeStatus::State::kCharging:
            return "charging";
        case ChargeStatus::State::kFull:
            return "full";
        case ChargeStatus::State::kNoBattery:
            return "no_battery";
    }
    return "unknown";
}

std::string BuildDeviceStatusJson() {
    cJSON* root = cJSON_CreateObject();

    cJSON* audio = cJSON_CreateObject();
    const int chat_level = xiaozhi::settings::GetVolume();
    cJSON_AddNumberToObject(audio, "volume", vol::ToCodec(chat_level));
    cJSON_AddNumberToObject(audio, "level", chat_level);
    cJSON_AddNumberToObject(audio, "max_level", vol::kMax);
    cJSON_AddNumberToObject(audio, "album_level", vol::GetAlbum());
    cJSON_AddBoolToObject(audio, "chat_active", xiaozhi::AudioService::Get().IsActive());
    cJSON_AddBoolToObject(audio, "voice_processing", xiaozhi::AudioService::Get().IsVoiceProcessing());
    cJSON_AddItemToObject(root, "audio_speaker", audio);

    auto& board = Board::Get();
    if (auto* charge = board.charge()) {
        const auto snap = charge->Get();
        cJSON* battery = cJSON_CreateObject();
        uint16_t mv = 0;
        uint8_t pct = 0;
        const bool have_battery = board.ReadBattery(&mv, &pct);
        cJSON_AddStringToObject(battery, "state", ChargeStateName(snap.state).c_str());
        cJSON_AddBoolToObject(battery, "power_present", snap.power_present);
        cJSON_AddBoolToObject(battery, "charging", snap.charging);
        cJSON_AddBoolToObject(battery, "full", snap.full);
        cJSON_AddBoolToObject(battery, "no_battery", snap.no_battery);
        if (have_battery) {
            cJSON_AddNumberToObject(battery, "voltage_mv", mv);
            cJSON_AddNumberToObject(battery, "level", pct);
        }
        cJSON_AddItemToObject(root, "battery", battery);
    }

    cJSON* network = cJSON_CreateObject();
    cJSON_AddStringToObject(network, "type", "wifi");
    cJSON_AddBoolToObject(network, "connected", Wifi::Get().IsConnected());
    if (Wifi::Get().IsConnected()) {
        cJSON_AddNumberToObject(network, "rssi", Wifi::Get().GetRssi());
        cJSON_AddStringToObject(network, "ip", Wifi::Get().GetIp().c_str());
    }
    cJSON_AddItemToObject(root, "network", network);

    const auto snap = xiaozhi::ChatService::Get().Snapshot();
    cJSON* chat = cJSON_CreateObject();
    cJSON_AddStringToObject(chat, "state", ChatStateName(snap.state).c_str());
    cJSON_AddStringToObject(chat, "status", snap.status.c_str());
    cJSON_AddBoolToObject(chat, "has_protocol", snap.has_protocol);
    cJSON_AddNumberToObject(chat, "volume", vol::ToCodec(snap.volume));
    cJSON_AddNumberToObject(chat, "level", snap.volume);
    if (!snap.user_text.empty())
        cJSON_AddStringToObject(chat, "user_text", snap.user_text.c_str());
    if (!snap.assistant_text.empty())
        cJSON_AddStringToObject(chat, "assistant_text", snap.assistant_text.c_str());
    if (!snap.error.empty())
        cJSON_AddStringToObject(chat, "error", snap.error.c_str());
    cJSON_AddItemToObject(root, "xiaozhi", chat);

    return PrintAndDelete(root);
}

std::string TextResultJson(const std::string& text) {
    cJSON* result = cJSON_CreateObject();
    cJSON* content = cJSON_CreateArray();
    cJSON* item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "type", "text");
    cJSON_AddStringToObject(item, "text", text.c_str());
    cJSON_AddItemToArray(content, item);
    cJSON_AddItemToObject(result, "content", content);
    cJSON_AddBoolToObject(result, "isError", false);
    return PrintAndDelete(result);
}

cJSON* MakeObjectSchema() {
    cJSON* schema = cJSON_CreateObject();
    cJSON_AddStringToObject(schema, "type", "object");
    cJSON_AddItemToObject(schema, "properties", cJSON_CreateObject());
    return schema;
}

std::string ToolListResultJson() {
    cJSON* result = cJSON_CreateObject();
    cJSON* tools = cJSON_CreateArray();

    cJSON* status_tool = cJSON_CreateObject();
    cJSON_AddStringToObject(status_tool, "name", "self.get_device_status");
    cJSON_AddStringToObject(status_tool, "description",
                            "Provides the real-time information of the device, including the current status of the audio speaker, screen, battery, network, etc.\n"
                            "Use this tool for: \n"
                            "1. Answering questions about current condition (e.g. what is the current volume of the audio speaker?)\n"
                            "2. As the first step to control the device (e.g. turn up / down the volume of the audio speaker, etc.)");
    cJSON_AddItemToObject(status_tool, "inputSchema", MakeObjectSchema());
    cJSON_AddItemToArray(tools, status_tool);

    cJSON* volume_tool = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_tool, "name", "self.audio_speaker.set_volume");
    cJSON_AddStringToObject(volume_tool, "description",
                            "Set the volume of the audio speaker. If the current volume is unknown, you must call `self.get_device_status` tool first and then call this tool.");
    cJSON* volume_schema = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_schema, "type", "object");
    cJSON* properties = cJSON_CreateObject();
    cJSON* volume_prop = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_prop, "type", "integer");
    cJSON_AddNumberToObject(volume_prop, "minimum", 0);
    cJSON_AddNumberToObject(volume_prop, "maximum", 100);
    cJSON_AddItemToObject(properties, "volume", volume_prop);
    cJSON_AddItemToObject(volume_schema, "properties", properties);
    cJSON* required = cJSON_CreateArray();
    cJSON_AddItemToArray(required, cJSON_CreateString("volume"));
    cJSON_AddItemToObject(volume_schema, "required", required);
    cJSON_AddItemToObject(volume_tool, "inputSchema", volume_schema);
    cJSON_AddItemToArray(tools, volume_tool);

    cJSON_AddItemToObject(result, "tools", tools);
    return PrintAndDelete(result);
}

std::string JsonRpcResult(const std::string& id, const std::string& result) {
    return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}";
}

std::string JsonRpcError(const std::string& id, int code, const std::string& message) {
    cJSON* error = cJSON_CreateObject();
    cJSON_AddNumberToObject(error, "code", code);
    cJSON_AddStringToObject(error, "message", message.c_str());
    std::string error_json = PrintAndDelete(error);
    return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"error\":" + error_json + "}";
}
}

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
    error_occurred_ = true;
    ESP_LOGW(kTag, "Network error: %s", message.c_str());
    if (on_network_error_) {
        on_network_error_(message);
    }
}

void Protocol::PrepareAudioChannelOpen() {
    audio_channel_close_requested_.store(false, std::memory_order_relaxed);
}

void Protocol::MarkAudioChannelCloseRequested() {
    audio_channel_close_requested_.store(true, std::memory_order_relaxed);
}

bool Protocol::IsAudioChannelCloseRequested() const {
    return audio_channel_close_requested_.load(std::memory_order_relaxed);
}

void Protocol::SendStartListening(ListeningMode mode) {
    std::string message = "{\"session_id\":\"" + session_id_ + "\",\"type\":\"listen\",\"state\":\"start\",\"mode\":\"";
    message += (mode == ListeningMode::kManualStop) ? "manual" : "auto";
    message += "\"}";
    SendText(message);
}

void Protocol::SendStopListening() {
    std::string message = "{\"session_id\":\"" + session_id_ + "\",\"type\":\"listen\",\"state\":\"stop\"}";
    SendText(message);
}

void Protocol::SendAbortSpeaking(AbortReason reason) {
    std::string message = "{\"session_id\":\"" + session_id_ + "\",\"type\":\"abort\"";
    if (reason == AbortReason::kWakeWordDetected) {
        message += ",\"reason\":\"wake_word_detected\"";
    }
    message += "}";
    SendText(message);
}

void Protocol::SendMcpMessage(const std::string& payload) {
    auto* queued = new (std::nothrow) std::string(payload);
    if (!queued) {
        ESP_LOGW(kTag, "MCP tx dropped: alloc failed bytes=%u", static_cast<unsigned>(payload.size()));
        return;
    }

    std::lock_guard<std::mutex> lock(mcp_mutex_);
    if (!mcp_accepting_.load(std::memory_order_relaxed)) {
        delete queued;
        return;
    }
    if (!StartMcpSendTaskLocked() ||
        !mcp_send_queue_ ||
        xQueueSendToBack(mcp_send_queue_, &queued, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(kTag, "MCP tx dropped: queue unavailable/full bytes=%u", static_cast<unsigned>(payload.size()));
        delete queued;
        return;
    }
}

bool Protocol::StartMcpSendTaskLocked() {
    if (mcp_send_queue_ && mcp_send_task_)
        return true;
    if (!mcp_send_queue_) {
        mcp_send_queue_ = xQueueCreate(4, sizeof(std::string*));
        if (!mcp_send_queue_) {
            ESP_LOGW(kTag, "MCP send queue create failed");
            return false;
        }
    }
    if (!mcp_send_task_) {
        const BaseType_t ok =
            xTaskCreatePinnedToCore(&Protocol::McpSendTaskEntry, "xiaozhi_mcp_tx", 4096, this, 3, &mcp_send_task_, 0);
        if (ok != pdPASS) {
            ESP_LOGW(kTag, "MCP send task create failed");
            vQueueDelete(mcp_send_queue_);
            mcp_send_queue_ = nullptr;
            return false;
        }
    }
    return true;
}

void Protocol::StopMcpSendTask() {
    TaskHandle_t task = nullptr;
    QueueHandle_t queue = nullptr;
    {
        std::lock_guard<std::mutex> lock(mcp_mutex_);
        mcp_accepting_.store(false, std::memory_order_relaxed);
        task = mcp_send_task_;
        queue = mcp_send_queue_;
        if (task)
            mcp_stop_waiter_ = xTaskGetCurrentTaskHandle();
    }

    if (task) {
        std::string* sentinel = nullptr;
        bool sentinel_sent = false;
        if (queue) {
            for (int attempt = 0; attempt < 2 && !sentinel_sent; ++attempt) {
                sentinel_sent = xQueueSendToBack(queue, &sentinel, pdMS_TO_TICKS(100)) == pdTRUE;
                if (!sentinel_sent) {
                    std::string* dropped = nullptr;
                    if (xQueueReceive(queue, &dropped, 0) == pdTRUE)
                        delete dropped;
                }
            }
        }
        if (sentinel_sent) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        } else {
            ESP_LOGW(kTag, "MCP send task stop sentinel could not be queued");
        }
    }

    {
        std::lock_guard<std::mutex> lock(mcp_mutex_);
        mcp_stop_waiter_ = nullptr;
        if (mcp_send_task_) {
            ESP_LOGW(kTag, "MCP send task did not stop; keep queue alive");
            return;
        }
        queue = mcp_send_queue_;
        mcp_send_queue_ = nullptr;
    }

    if (queue) {
        std::string* queued = nullptr;
        while (xQueueReceive(queue, &queued, 0) == pdTRUE) {
            delete queued;
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
        std::string* payload = nullptr;
        if (xQueueReceive(queue, &payload, portMAX_DELAY) != pdTRUE)
            continue;
        if (!payload) {
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

        while (mcp_accepting_.load(std::memory_order_relaxed) && !audio_channel_ready_.load(std::memory_order_relaxed))
            vTaskDelay(pdMS_TO_TICKS(10));

        if (!mcp_accepting_.load(std::memory_order_relaxed) ||
            !audio_channel_ready_.load(std::memory_order_relaxed) ||
            session_id_.empty()) {
            delete payload;
            continue;
        }

        std::string message = "{\"session_id\":\"" + session_id_ + "\",\"type\":\"mcp\",\"payload\":" + *payload + "}";
        SendText(message);
        delete payload;
    }
}

bool Protocol::HandleMcpMessage(const cJSON* root) {
    cJSON* payload = cJSON_GetObjectItem(root, "payload");
    if (!cJSON_IsObject(payload))
        return false;

    const std::string method = JsonString(payload, "method");
    const std::string id = JsonId(cJSON_GetObjectItem(payload, "id"));

    if (!mcp_accepting_.load(std::memory_order_relaxed)) {
        return true;
    }

    if (method.rfind("notifications", 0) == 0)
        return true;

    if (id.empty()) {
        ESP_LOGW(kTag, "Ignore MCP request without id: %s", method.c_str());
        return true;
    }

    if (method == "initialize") {
        const auto* app = esp_app_get_description();
        std::string result = "{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},"
                             "\"serverInfo\":{\"name\":\"slate\",\"version\":\"";
        result += app ? app->version : "unknown";
        result += "\"}}";
        SendMcpMessage(JsonRpcResult(id, result));
        return true;
    }

    if (method == "tools/list") {
        SendMcpMessage(JsonRpcResult(id, ToolListResultJson()));
        return true;
    }

    if (method == "tools/call") {
        cJSON* params = cJSON_GetObjectItem(payload, "params");
        if (!cJSON_IsObject(params)) {
            SendMcpMessage(JsonRpcError(id, -32602, "Missing params"));
            return true;
        }
        cJSON* name = cJSON_GetObjectItem(params, "name");
        if (!cJSON_IsString(name) || !name->valuestring) {
            SendMcpMessage(JsonRpcError(id, -32602, "Missing tool name"));
            return true;
        }
        const std::string tool_name = name->valuestring;
        if (tool_name == "self.get_device_status") {
            SendMcpMessage(JsonRpcResult(id, TextResultJson(BuildDeviceStatusJson())));
            return true;
        }
        if (tool_name == "self.audio_speaker.set_volume") {
            cJSON* arguments = cJSON_GetObjectItem(params, "arguments");
            cJSON* volume = cJSON_IsObject(arguments) ? cJSON_GetObjectItem(arguments, "volume") : nullptr;
            if (!cJSON_IsNumber(volume)) {
                SendMcpMessage(JsonRpcError(id, -32602, "Missing volume"));
                return true;
            }
            const int codec_volume = std::clamp(volume->valueint, 0, 100);
            const int level = std::clamp((codec_volume + 5) / 10, 0, vol::kMax);
            ChatService::Get().SetVolume(level);
            SendMcpMessage(JsonRpcResult(id, TextResultJson("true")));
            return true;
        }
        SendMcpMessage(JsonRpcError(id, -32601, "Unknown tool: " + tool_name));
        return true;
    }

    SendMcpMessage(JsonRpcError(id, -32601, "Method not implemented"));
    return true;
}

bool Protocol::IsTimeout() const {
    constexpr int kTimeoutSeconds = 120;
    const auto now = std::chrono::steady_clock::now();
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
