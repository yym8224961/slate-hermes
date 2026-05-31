#include "xiaozhi/protocol/websocket_protocol.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_network.h>

#include <cstring>
#include <memory>
#include <string>

#include "utils/byte_utils.h"
#include "utils/json_utils.h"
#include "xiaozhi/config/activation_client.h"
#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "XiaoWS";

constexpr size_t kBinaryProtocol2HeaderSize = 16;
constexpr size_t kBinaryProtocol3HeaderSize = 4;

}  // namespace

namespace xiaozhi {

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
    auto close_failed_channel = [this](const char* error) {
        if (error)
            SetError(error);
        CloseAudioChannel(false);
        return false;
    };

    settings::WebsocketConfig cfg;
    if (!settings::LoadWebsocket(cfg)) {
        SetError("未获取 WebSocket 配置");
        return false;
    }
    if (cfg.version > 0)
        version_.store(cfg.version, std::memory_order_release);

    error_occurred_.store(false, std::memory_order_release);
    mcp_accepting_.store(true, std::memory_order_relaxed);
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    ClearSessionId();
    ResetIncomingTimeout();
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        channel_open_notified_ = false;
        websocket_.reset();
        network_.reset();
    }
    xEventGroupClearBits(event_group_, kServerHelloEvent | kChannelClosedEvent);
    if (IsAudioChannelCloseRequested())
        return false;

    auto network   = std::make_unique<EspNetwork>();
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
    const std::string protocol_version = std::to_string(version_.load(std::memory_order_acquire));
    websocket->SetHeader("Protocol-Version", protocol_version.c_str());
    ActivationClient  client;
    const std::string device_id = client.DeviceId();
    const std::string client_id = settings::GetUuid();
    websocket->SetHeader("Device-Id", device_id.c_str());
    websocket->SetHeader("Client-Id", client_id.c_str());
    websocket->OnData([this](const char* data, size_t len, bool binary) { HandleIncomingData(data, len, binary); });
    websocket->OnDisconnected([this]() {
        ESP_LOGW(kTag, "WS disconnected");
        bool notify_closed = false;
        {
            std::lock_guard<std::mutex> lock(channel_mutex_);
            notify_closed          = channel_open_notified_;
            channel_open_notified_ = false;
        }
        audio_channel_ready_.store(false, std::memory_order_relaxed);
        if (event_group_)
            xEventGroupSetBits(event_group_, kChannelClosedEvent);
        if (notify_closed)
            PostChannelClosedEvent();
    });
    websocket->OnError([this](int err) { ESP_LOGW(kTag, "WS error: %d", err); });

    if (!websocket->Connect(cfg.url.c_str())) {
        SetError("连接小智 WebSocket 失败");
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (IsAudioChannelCloseRequested())
            return false;
        network_   = std::move(network);
        websocket_ = std::move(websocket);
    }
    const std::string hello = GetHelloMessage();
    if (!SendText(hello))
        return close_failed_channel("发送小智 WebSocket hello 失败");

    const EventBits_t bits = xEventGroupWaitBits(event_group_, kServerHelloEvent | kChannelClosedEvent, pdTRUE, pdFALSE,
                                                 pdMS_TO_TICKS(10000));
    if (bits & kChannelClosedEvent) {
        // ParseServerHello 失败时已 SetError 具体原因,这里只在还未设过 error 时
        // 兜底报"连接已断开",避免覆盖具体诊断信息。
        if (!IsAudioChannelCloseRequested() && !error_occurred_.load(std::memory_order_acquire))
            SetError("小智 WebSocket 连接已断开");
        return close_failed_channel(nullptr);
    }
    if (!(bits & kServerHelloEvent)) {
        ESP_LOGW(kTag, "WS server hello timeout: connected=%d", websocket_ && websocket_->IsConnected() ? 1 : 0);
        return close_failed_channel("小智 WebSocket 响应超时");
    }
    bool close_requested = false;
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        close_requested = IsAudioChannelCloseRequested();
        if (!close_requested) {
            channel_open_notified_ = true;
            audio_channel_ready_.store(true, std::memory_order_relaxed);
        }
    }
    if (close_requested)
        return close_failed_channel(nullptr);
    if (on_audio_channel_opened_)
        on_audio_channel_opened_();
    return true;
}

void WebsocketProtocol::CloseAudioChannel(bool send_goodbye) {
    MarkAudioChannelCloseRequested();
    if (event_group_)
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    mcp_accepting_.store(false, std::memory_order_relaxed);
    StopMcpSendTask();
    const std::string session_id = SessionIdCopy();
    if (send_goodbye && !session_id.empty()) {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (websocket_ && websocket_->IsConnected()) {
            websocket_->Send("{\"session_id\":" + json_utils::JsonStringLiteral(session_id) + ",\"type\":\"goodbye\"}");
        }
    }
    std::unique_ptr<WebSocket>  websocket;
    std::unique_ptr<EspNetwork> network;
    bool                        notify_closed = false;
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        notify_closed          = channel_open_notified_;
        channel_open_notified_ = false;
        websocket              = std::move(websocket_);
        network                = std::move(network_);
    }
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    if (websocket) {
        websocket->OnData({});
        websocket->OnDisconnected({});
        websocket->OnError({});
    }
    websocket.reset();
    network.reset();
    if (notify_closed && on_audio_channel_closed_)
        on_audio_channel_closed_();
}

bool WebsocketProtocol::IsAudioChannelOpened() const {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    return websocket_ && websocket_->IsConnected() && !error_occurred_.load(std::memory_order_acquire) && !IsTimeout();
}

bool WebsocketProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!websocket_ || !websocket_->IsConnected() || !packet)
        return false;
    const int version = version_.load(std::memory_order_acquire);
    if (version == 2)
        return SendProtocol2Audio(*packet);
    if (version == 3)
        return SendProtocol3Audio(*packet);
    return websocket_->Send(packet->payload.data(), packet->payload.size(), true);
}

bool WebsocketProtocol::SendText(const std::string& text) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!websocket_ || !websocket_->IsConnected()) {
        ESP_LOGW(kTag, "WS tx failed: disconnected bytes=%u", static_cast<unsigned>(text.size()));
        return false;
    }
    const bool ok = websocket_->Send(text);
    return ok;
}

void WebsocketProtocol::HandleIncomingData(const char* data, size_t len, bool binary) {
    const bool handled = binary ? HandleIncomingBinary(data, len) : HandleIncomingText(data, len);
    if (handled)
        MarkIncomingNow();
}

bool WebsocketProtocol::HandleIncomingBinary(const char* data, size_t len) {
    if (!on_incoming_audio_)
        return false;

    int sample_rate    = 0;
    int frame_duration = 0;
    GetServerAudioParams(sample_rate, frame_duration);

    auto packet            = std::make_unique<AudioStreamPacket>();
    packet->sample_rate    = sample_rate;
    packet->frame_duration = frame_duration;
    const int version      = version_.load(std::memory_order_acquire);
    if (version == 2 && len >= kBinaryProtocol2HeaderSize) {
        const uint32_t payload_size = util::ReadBe32(data + 12);
        if (payload_size > len - kBinaryProtocol2HeaderSize)
            return false;
        packet->timestamp  = util::ReadBe32(data + 8);
        const auto payload = reinterpret_cast<const uint8_t*>(data + kBinaryProtocol2HeaderSize);
        packet->payload.assign(payload, payload + payload_size);
    } else if (version == 3 && len >= kBinaryProtocol3HeaderSize) {
        const uint16_t payload_size = util::ReadBe16(data + 2);
        if (payload_size > len - kBinaryProtocol3HeaderSize)
            return false;
        const auto payload = reinterpret_cast<const uint8_t*>(data + kBinaryProtocol3HeaderSize);
        packet->payload.assign(payload, payload + payload_size);
    } else {
        const auto payload = reinterpret_cast<const uint8_t*>(data);
        packet->payload.assign(payload, payload + len);
    }
    on_incoming_audio_(std::move(packet));
    return true;
}

bool WebsocketProtocol::HandleIncomingText(const char* data, size_t len) {
    cJSON* root = cJSON_ParseWithLength(data, len);
    if (!root) {
        ESP_LOGW(kTag, "WS rx ignored: invalid JSON");
        return false;
    }
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
    return true;
}

bool WebsocketProtocol::SendProtocol2Audio(const AudioStreamPacket& packet) {
    if (packet.payload.size() > UINT32_MAX)
        return false;
    auto& out = send_buffer_;
    out.resize(kBinaryProtocol2HeaderSize + packet.payload.size());
    util::WriteBe16(out.data(), 2);
    util::WriteBe16(out.data() + 2, 0);
    util::WriteBe32(out.data() + 4, 0);
    util::WriteBe32(out.data() + 8, packet.timestamp);
    util::WriteBe32(out.data() + 12, static_cast<uint32_t>(packet.payload.size()));
    std::memcpy(out.data() + kBinaryProtocol2HeaderSize, packet.payload.data(), packet.payload.size());
    return websocket_->Send(out.data(), out.size(), true);
}

bool WebsocketProtocol::SendProtocol3Audio(const AudioStreamPacket& packet) {
    if (packet.payload.size() > UINT16_MAX)
        return false;
    auto& out = send_buffer_;
    out.resize(kBinaryProtocol3HeaderSize + packet.payload.size());
    out[0] = 0;
    out[1] = 0;
    util::WriteBe16(out.data() + 2, static_cast<uint16_t>(packet.payload.size()));
    std::memcpy(out.data() + kBinaryProtocol3HeaderSize, packet.payload.data(), packet.payload.size());
    return websocket_->Send(out.data(), out.size(), true);
}

std::string WebsocketProtocol::GetHelloMessage() const {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "hello");
    cJSON_AddNumberToObject(root, "version", version_.load(std::memory_order_acquire));
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
    return json_utils::PrintAndDelete(root);
}

void WebsocketProtocol::ParseServerHello(const cJSON* root) {
    // 失败路径走 SetError + setBits(kChannelClosedEvent),让 OpenAudioChannel 立刻
    // 退出等待并保留具体错误原因,不再等满 10s 才报"响应超时"。
    auto fail = [this](const char* reason) {
        SetError(reason);
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    };
    cJSON* transport = cJSON_GetObjectItem(root, "transport");
    if (!cJSON_IsString(transport) || std::strcmp(transport->valuestring, "websocket") != 0) {
        ESP_LOGW(kTag, "Server hello ignored: transport=%s",
                 cJSON_IsString(transport) ? transport->valuestring : "(missing)");
        fail("小智 WebSocket 协议不匹配");
        return;
    }
    cJSON* sid = cJSON_GetObjectItem(root, "session_id");
    if (cJSON_IsString(sid))
        SetSessionId(sid->valuestring);
    cJSON* version = cJSON_GetObjectItem(root, "version");
    if (cJSON_IsNumber(version) && version->valueint >= 1 && version->valueint <= 3)
        version_.store(version->valueint, std::memory_order_release);
    int sample_rate    = server_sample_rate_;
    int frame_duration = server_frame_duration_;
    GetServerAudioParams(sample_rate, frame_duration);
    cJSON* audio = cJSON_GetObjectItem(root, "audio_params");
    if (cJSON_IsObject(audio)) {
        cJSON* sample_rate_item    = cJSON_GetObjectItem(audio, "sample_rate");
        cJSON* frame_duration_item = cJSON_GetObjectItem(audio, "frame_duration");
        if (cJSON_IsNumber(sample_rate_item)) {
            if (!IsSupportedOpusSampleRate(sample_rate_item->valueint)) {
                ESP_LOGW(kTag, "Server hello ignored: invalid sample_rate=%d", sample_rate_item->valueint);
                fail("小智 WebSocket 音频采样率不支持");
                return;
            }
            sample_rate = sample_rate_item->valueint;
        }
        if (cJSON_IsNumber(frame_duration_item)) {
            if (!IsSupportedOpusFrameDuration(frame_duration_item->valueint)) {
                ESP_LOGW(kTag, "Server hello ignored: invalid frame_duration=%d", frame_duration_item->valueint);
                fail("小智 WebSocket 音频帧长不支持");
                return;
            }
            frame_duration = frame_duration_item->valueint;
        }
    }
    SetServerAudioParams(sample_rate, frame_duration);
    xEventGroupSetBits(event_group_, kServerHelloEvent);
}

}  // namespace xiaozhi
