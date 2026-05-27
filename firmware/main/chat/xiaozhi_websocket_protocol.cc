#include "xiaozhi_websocket_protocol.h"

#include <arpa/inet.h>
#include <cJSON.h>
#include <esp_log.h>
#include <esp_network.h>

#include <cstring>
#include <memory>
#include <string>

#include "event_bus.h"
#include "xiaozhi_config_client.h"
#include "xiaozhi_settings.h"

namespace {
constexpr char kTag[] = "XiaoWS";

constexpr size_t kBinaryProtocol2HeaderSize = 16;
constexpr size_t kBinaryProtocol3HeaderSize = 4;

uint16_t ReadBe16(const char* data) {
    uint16_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return ntohs(value);
}

uint32_t ReadBe32(const char* data) {
    uint32_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return ntohl(value);
}

void WriteBe16(char* data, uint16_t value) {
    value = htons(value);
    std::memcpy(data, &value, sizeof(value));
}

void WriteBe32(char* data, uint32_t value) {
    value = htonl(value);
    std::memcpy(data, &value, sizeof(value));
}

std::string JsonType(const cJSON* root) {
    cJSON* type = cJSON_GetObjectItem(root, "type");
    return cJSON_IsString(type) && type->valuestring ? type->valuestring : "";
}

std::string LogPayloadSummary(const cJSON* root, size_t bytes) {
    const std::string type = JsonType(root);
    if (type == "tts") {
        cJSON* state = cJSON_GetObjectItem(root, "state");
        std::string out = "type=tts state=";
        out += cJSON_IsString(state) ? state->valuestring : "";
        return out;
    }
    if (type == "stt") {
        cJSON* text = cJSON_GetObjectItem(root, "text");
        std::string out = "type=stt text_len=";
        out += std::to_string(cJSON_IsString(text) && text->valuestring ? std::strlen(text->valuestring) : 0);
        return out;
    }
    if (type == "llm") {
        cJSON* emotion = cJSON_GetObjectItem(root, "emotion");
        std::string out = "type=llm emotion=";
        out += cJSON_IsString(emotion) ? emotion->valuestring : "";
        return out;
    }
    if (type == "mcp") {
        cJSON* rpc = cJSON_GetObjectItem(cJSON_GetObjectItem(root, "payload"), "method");
        std::string out = "type=mcp method=";
        out += cJSON_IsString(rpc) ? rpc->valuestring : "";
        return out;
    }
    return "type=" + type + " bytes=" + std::to_string(bytes);
}

std::string LogPayloadSummary(const std::string& payload) {
    cJSON* root = cJSON_Parse(payload.c_str());
    if (!root)
        return "invalid-json";
    std::string out = LogPayloadSummary(root, payload.size());
    cJSON_Delete(root);
    return out;
}
}

namespace xiaozhi {

namespace {
void PostChannelClosed(uint32_t token) {
    UiEvent e{};
    e.kind                    = UiEventKind::kXiaozhiChannelClosed;
    e.u.xiaozhi_channel.token = token;
    evt::Post(e, 0);
}
}  // namespace

WebsocketProtocol::WebsocketProtocol() {
    event_group_ = xEventGroupCreate();
}

WebsocketProtocol::~WebsocketProtocol() {
    StopMcpSendTask();
    CloseAudioChannel(false);
    if (event_group_) {
        vEventGroupDelete(event_group_);
        event_group_ = nullptr;
    }
}

bool WebsocketProtocol::Start() {
    return true;
}

bool WebsocketProtocol::OpenAudioChannel() {
    settings::WebsocketConfig cfg;
    if (!settings::LoadWebsocket(cfg)) {
        SetError("未获取 WebSocket 配置");
        return false;
    }
    if (cfg.version > 0)
        version_ = cfg.version;
    ESP_LOGI(kTag, "WS config: url=%s token_len=%u version=%d",
             cfg.url.c_str(),
             static_cast<unsigned>(cfg.token.size()),
             version_);

    error_occurred_ = false;
    mcp_accepting_.store(true, std::memory_order_relaxed);
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    session_id_.clear();
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        channel_open_notified_ = false;
        websocket_.reset();
        network_.reset();
    }
    xEventGroupClearBits(event_group_, kServerHelloEvent | kChannelClosedEvent);
    if (IsAudioChannelCloseRequested())
        return false;

    auto network = std::make_unique<EspNetwork>();
    auto websocket = network->CreateWebSocket(1);
    if (!websocket) {
        SetError("WebSocket 初始化失败");
        return false;
    }
    std::string token = cfg.token;
    if (!token.empty()) {
        if (token.find(' ') == std::string::npos)
            token = "Bearer " + token;
        websocket->SetHeader("Authorization", token.c_str());
    }
    const std::string protocol_version = std::to_string(version_);
    websocket->SetHeader("Protocol-Version", protocol_version.c_str());
    ConfigClient client;
    const std::string device_id = client.DeviceId();
    const std::string client_id = settings::GetUuid();
    websocket->SetHeader("Device-Id", device_id.c_str());
    websocket->SetHeader("Client-Id", client_id.c_str());
    websocket->OnData([this](const char* data, size_t len, bool binary) {
        if (binary) {
            if (!on_incoming_audio_)
                return;
            if (version_ == 2 && len >= kBinaryProtocol2HeaderSize) {
                const uint32_t timestamp = ReadBe32(data + 8);
                const uint32_t payload_size = ReadBe32(data + 12);
                if (payload_size > len - kBinaryProtocol2HeaderSize)
                    return;
                auto payload = reinterpret_cast<const uint8_t*>(data + kBinaryProtocol2HeaderSize);
                auto packet = std::make_unique<AudioStreamPacket>();
                packet->sample_rate = server_sample_rate_;
                packet->frame_duration = server_frame_duration_;
                packet->timestamp = timestamp;
                packet->payload.assign(payload, payload + payload_size);
                on_incoming_audio_(std::move(packet));
            } else if (version_ == 3 && len >= kBinaryProtocol3HeaderSize) {
                const uint16_t payload_size = ReadBe16(data + 2);
                if (payload_size > len - kBinaryProtocol3HeaderSize)
                    return;
                auto payload = reinterpret_cast<const uint8_t*>(data + kBinaryProtocol3HeaderSize);
                auto packet = std::make_unique<AudioStreamPacket>();
                packet->sample_rate = server_sample_rate_;
                packet->frame_duration = server_frame_duration_;
                packet->payload.assign(payload, payload + payload_size);
                on_incoming_audio_(std::move(packet));
            } else {
                auto packet = std::make_unique<AudioStreamPacket>();
                packet->sample_rate = server_sample_rate_;
                packet->frame_duration = server_frame_duration_;
                packet->payload.assign(reinterpret_cast<const uint8_t*>(data),
                                       reinterpret_cast<const uint8_t*>(data) + len);
                on_incoming_audio_(std::move(packet));
            }
        } else {
            cJSON* root = cJSON_ParseWithLength(data, len);
            if (!root) {
                ESP_LOGW(kTag, "WS rx ignored: invalid JSON");
                return;
            }
            ESP_LOGI(kTag, "WS rx: bytes=%u %s",
                     static_cast<unsigned>(len),
                     LogPayloadSummary(root, len).c_str());
            cJSON* type = cJSON_GetObjectItem(root, "type");
            if (cJSON_IsString(type)) {
                if (std::strcmp(type->valuestring, "hello") == 0) {
                    ParseServerHello(root);
                } else if (std::strcmp(type->valuestring, "mcp") == 0 && HandleMcpMessage(root)) {
                } else if (on_incoming_json_) {
                    on_incoming_json_(root);
                }
            }
            cJSON_Delete(root);
        }
        last_incoming_time_ = std::chrono::steady_clock::now();
    });
    websocket->OnDisconnected([this]() {
        ESP_LOGW(kTag, "WS disconnected");
        bool notify_closed = false;
        {
            std::lock_guard<std::mutex> lock(channel_mutex_);
            notify_closed = channel_open_notified_;
            channel_open_notified_ = false;
        }
        audio_channel_ready_.store(false, std::memory_order_relaxed);
        if (event_group_)
            xEventGroupSetBits(event_group_, kChannelClosedEvent);
        if (notify_closed)
            PostChannelClosed(owner_token_);
    });
    websocket->OnError([this](int err) {
        ESP_LOGW(kTag, "WS error: %d", err);
    });

    ESP_LOGI(kTag, "Connect %s version=%d", cfg.url.c_str(), version_);
    if (!websocket->Connect(cfg.url.c_str())) {
        SetError("连接小智 WebSocket 失败");
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (IsAudioChannelCloseRequested())
            return false;
        network_ = std::move(network);
        websocket_ = std::move(websocket);
    }
    const std::string hello = GetHelloMessage();
    ESP_LOGI(kTag, "WS tx hello: bytes=%u %s",
             static_cast<unsigned>(hello.size()),
             LogPayloadSummary(hello).c_str());
    if (!SendText(hello))
        return false;

    ESP_LOGI(kTag, "Waiting WS server hello");
    const EventBits_t bits = xEventGroupWaitBits(event_group_,
                                                 kServerHelloEvent | kChannelClosedEvent,
                                                 pdTRUE,
                                                 pdFALSE,
                                                 pdMS_TO_TICKS(10000));
    if (bits & kChannelClosedEvent) {
        if (!IsAudioChannelCloseRequested())
            SetError("小智 WebSocket 连接已断开");
        return false;
    }
    if (!(bits & kServerHelloEvent)) {
        ESP_LOGW(kTag, "WS server hello timeout: connected=%d session_id=%s",
                 websocket_ && websocket_->IsConnected() ? 1 : 0,
                 session_id_.c_str());
        SetError("小智 WebSocket 响应超时");
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (IsAudioChannelCloseRequested())
            return false;
        channel_open_notified_ = true;
        audio_channel_ready_.store(true, std::memory_order_relaxed);
    }
    if (on_audio_channel_opened_)
        on_audio_channel_opened_();
    return true;
}

void WebsocketProtocol::CloseAudioChannel(bool send_goodbye) {
    (void)send_goodbye;
    MarkAudioChannelCloseRequested();
    if (event_group_)
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    mcp_accepting_.store(false, std::memory_order_relaxed);
    StopMcpSendTask();
    std::unique_ptr<WebSocket> websocket;
    std::unique_ptr<EspNetwork> network;
    bool notify_closed = false;
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        notify_closed = channel_open_notified_;
        channel_open_notified_ = false;
        websocket = std::move(websocket_);
        network = std::move(network_);
    }
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    websocket.reset();
    network.reset();
    if (notify_closed && on_audio_channel_closed_)
        on_audio_channel_closed_();
}

bool WebsocketProtocol::IsAudioChannelOpened() const {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    return websocket_ && websocket_->IsConnected() && !error_occurred_ && !IsTimeout();
}

bool WebsocketProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!websocket_ || !websocket_->IsConnected() || !packet)
        return false;
    if (version_ == 2) {
        if (packet->payload.size() > UINT32_MAX)
            return false;
        std::string out;
        out.resize(kBinaryProtocol2HeaderSize + packet->payload.size());
        WriteBe16(out.data(), static_cast<uint16_t>(version_));
        WriteBe16(out.data() + 2, 0);
        WriteBe32(out.data() + 4, 0);
        WriteBe32(out.data() + 8, packet->timestamp);
        WriteBe32(out.data() + 12, static_cast<uint32_t>(packet->payload.size()));
        std::memcpy(out.data() + kBinaryProtocol2HeaderSize, packet->payload.data(), packet->payload.size());
        return websocket_->Send(out.data(), out.size(), true);
    }
    if (version_ == 3) {
        if (packet->payload.size() > UINT16_MAX)
            return false;
        std::string out;
        out.resize(kBinaryProtocol3HeaderSize + packet->payload.size());
        out[0] = 0;
        out[1] = 0;
        WriteBe16(out.data() + 2, static_cast<uint16_t>(packet->payload.size()));
        std::memcpy(out.data() + kBinaryProtocol3HeaderSize, packet->payload.data(), packet->payload.size());
        return websocket_->Send(out.data(), out.size(), true);
    }
    return websocket_->Send(packet->payload.data(), packet->payload.size(), true);
}

bool WebsocketProtocol::SendText(const std::string& text) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!websocket_ || !websocket_->IsConnected()) {
        ESP_LOGW(kTag, "WS tx failed: disconnected bytes=%u", static_cast<unsigned>(text.size()));
        return false;
    }
    const bool ok = websocket_->Send(text);
    ESP_LOGI(kTag, "WS tx: ok=%d bytes=%u %s",
             ok ? 1 : 0,
             static_cast<unsigned>(text.size()),
             LogPayloadSummary(text).c_str());
    return ok;
}

std::string WebsocketProtocol::GetHelloMessage() const {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "hello");
    cJSON_AddNumberToObject(root, "version", version_);
    cJSON* features = cJSON_CreateObject();
    cJSON_AddBoolToObject(features, "mcp", true);
    cJSON_AddItemToObject(root, "features", features);
    cJSON_AddStringToObject(root, "transport", "websocket");
    cJSON* audio = cJSON_CreateObject();
    cJSON_AddStringToObject(audio, "format", "opus");
    cJSON_AddNumberToObject(audio, "sample_rate", kClientSampleRate);
    cJSON_AddNumberToObject(audio, "channels", 1);
    cJSON_AddNumberToObject(audio, "frame_duration", kOpusFrameDurationMs);
    cJSON_AddItemToObject(root, "audio_params", audio);
    char* raw = cJSON_PrintUnformatted(root);
    std::string out(raw ? raw : "{}");
    cJSON_free(raw);
    cJSON_Delete(root);
    return out;
}

void WebsocketProtocol::ParseServerHello(const cJSON* root) {
    cJSON* transport = cJSON_GetObjectItem(root, "transport");
    if (!cJSON_IsString(transport) || std::strcmp(transport->valuestring, "websocket") != 0) {
        ESP_LOGW(kTag, "Server hello ignored: transport=%s",
                 cJSON_IsString(transport) ? transport->valuestring : "(missing)");
        return;
    }
    cJSON* sid = cJSON_GetObjectItem(root, "session_id");
    if (cJSON_IsString(sid))
        session_id_ = sid->valuestring;
    cJSON* audio = cJSON_GetObjectItem(root, "audio_params");
    if (cJSON_IsObject(audio)) {
        cJSON* sample_rate = cJSON_GetObjectItem(audio, "sample_rate");
        cJSON* frame_duration = cJSON_GetObjectItem(audio, "frame_duration");
        if (cJSON_IsNumber(sample_rate))
            server_sample_rate_ = sample_rate->valueint;
        if (cJSON_IsNumber(frame_duration))
            server_frame_duration_ = frame_duration->valueint;
    }
    ESP_LOGI(kTag, "Server hello: session_id=%s sample_rate=%d frame_duration=%d",
             session_id_.c_str(),
             server_sample_rate_,
             server_frame_duration_);
    xEventGroupSetBits(event_group_, kServerHelloEvent);
}

}  // namespace xiaozhi
