#include "xiaozhi_mqtt_protocol.h"

#include <arpa/inet.h>
#include <cJSON.h>
#include <esp_log.h>
#include <esp_network.h>

#include <array>
#include <cstring>
#include <string>

#include "event_bus.h"
#include "xiaozhi_settings.h"

namespace {
constexpr char kTag[] = "XiaoMQTT";

uint8_t HexValue(char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    return 0;
}

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

std::string LogPayloadSummary(const std::string& payload) {
    cJSON* root = cJSON_Parse(payload.c_str());
    if (!root)
        return "invalid-json";
    const std::string type = JsonType(root);
    if (type == "tts") {
        cJSON* state = cJSON_GetObjectItem(root, "state");
        std::string out = "type=tts state=";
        out += cJSON_IsString(state) ? state->valuestring : "";
        cJSON_Delete(root);
        return out;
    }
    if (type == "stt") {
        cJSON* text = cJSON_GetObjectItem(root, "text");
        std::string out = "type=stt text_len=";
        out += std::to_string(cJSON_IsString(text) && text->valuestring ? std::strlen(text->valuestring) : 0);
        cJSON_Delete(root);
        return out;
    }
    if (type == "llm") {
        cJSON* emotion = cJSON_GetObjectItem(root, "emotion");
        std::string out = "type=llm emotion=";
        out += cJSON_IsString(emotion) ? emotion->valuestring : "";
        cJSON_Delete(root);
        return out;
    }
    if (type == "mcp") {
        cJSON* rpc = cJSON_GetObjectItem(cJSON_GetObjectItem(root, "payload"), "method");
        std::string out = "type=mcp method=";
        out += cJSON_IsString(rpc) ? rpc->valuestring : "";
        cJSON_Delete(root);
        return out;
    }
    std::string out = "type=" + type + " bytes=" + std::to_string(payload.size());
    cJSON_Delete(root);
    return out;
}
}  // namespace

namespace xiaozhi {

namespace {
void PostChannelClosed(uint32_t token) {
    UiEvent e{};
    e.kind                   = UiEventKind::kXiaozhiChannelClosed;
    e.u.xiaozhi_channel.token = token;
    evt::Post(e, 0);
}
}  // namespace

MqttProtocol::MqttProtocol() {
    event_group_ = xEventGroupCreate();
    mbedtls_aes_init(&aes_ctx_);
}

MqttProtocol::~MqttProtocol() {
    *alive_ = false;
    StopMcpSendTask();
    CloseAudioChannel(false);
    mqtt_.reset();
    mbedtls_aes_free(&aes_ctx_);
    if (event_group_) {
        vEventGroupDelete(event_group_);
        event_group_ = nullptr;
    }
}

bool MqttProtocol::Start() {
    return StartMqttClient(false);
}

bool MqttProtocol::StartMqttClient(bool report_error) {
    if (mqtt_) {
        mqtt_.reset();
    }

    settings::MqttConfig cfg;
    if (!settings::LoadMqtt(cfg)) {
        if (report_error)
            SetError("未获取 MQTT 配置");
        return false;
    }
    publish_topic_ = cfg.publish_topic;
    ESP_LOGI(kTag, "MQTT config: endpoint=%s client_id_len=%u username_len=%u publish_topic=%s keepalive=%ld",
             cfg.endpoint.c_str(),
             static_cast<unsigned>(cfg.client_id.size()),
             static_cast<unsigned>(cfg.username.size()),
             cfg.publish_topic.c_str(),
             static_cast<long>(cfg.keepalive));

    EspNetwork network;
    mqtt_ = network.CreateMqtt(0);
    mqtt_->SetKeepAlive(cfg.keepalive);
    mqtt_->OnConnected([this]() {
        ESP_LOGI(kTag, "MQTT connected");
        if (on_connected_)
            on_connected_();
    });
    mqtt_->OnDisconnected([this]() {
        ESP_LOGW(kTag, "MQTT disconnected");
        if (on_disconnected_)
            on_disconnected_();
        if (event_group_)
            xEventGroupSetBits(event_group_, kChannelClosedEvent);
        if (*alive_)
            PostChannelClosed(owner_token_);
    });
    mqtt_->OnError([this](const std::string& err) { ESP_LOGW(kTag, "MQTT error: %s", err.c_str()); });
    mqtt_->OnMessage([this](const std::string& topic, const std::string& payload) {
        ESP_LOGI(kTag, "MQTT rx: topic=%s bytes=%u %s",
                 topic.c_str(),
                 static_cast<unsigned>(payload.size()),
                 LogPayloadSummary(payload).c_str());
        cJSON* root = cJSON_Parse(payload.c_str());
        if (!root) {
            ESP_LOGW(kTag, "MQTT rx ignored: invalid JSON");
            return;
        }
        const std::string type = JsonType(root);
        if (!type.empty()) {
            if (type == "hello") {
                ParseServerHello(root);
            } else if (type == "goodbye") {
                cJSON* sid = cJSON_GetObjectItem(root, "session_id");
                ESP_LOGI(kTag, "MQTT goodbye: session_id=%s current=%s",
                         cJSON_IsString(sid) ? sid->valuestring : "(none)",
                         session_id_.c_str());
                if (!cJSON_IsString(sid) || session_id_ == sid->valuestring) {
                    mcp_accepting_.store(false, std::memory_order_relaxed);
                    xEventGroupSetBits(event_group_, kServerGoodbyeEvent);
                    PostChannelClosed(owner_token_);
                }
            } else if (type == "mcp" && HandleMcpMessage(root)) {
            } else if (on_incoming_json_) {
                on_incoming_json_(root);
            }
        } else {
            ESP_LOGW(kTag, "MQTT rx ignored: missing type");
        }
        cJSON_Delete(root);
        last_incoming_time_ = std::chrono::steady_clock::now();
    });

    std::string host = cfg.endpoint;
    int port = 8883;
    const size_t pos = cfg.endpoint.find(':');
    if (pos != std::string::npos) {
        host = cfg.endpoint.substr(0, pos);
        port = std::atoi(cfg.endpoint.substr(pos + 1).c_str());
    }

    ESP_LOGI(kTag, "Connect MQTT %s:%d", host.c_str(), port);
    if (!mqtt_->Connect(host, port, cfg.client_id, cfg.username, cfg.password)) {
        ESP_LOGW(kTag, "MQTT connect failed: last_error=%d", mqtt_->GetLastError());
        if (report_error)
            SetError("连接小智服务器失败");
        return false;
    }
    ESP_LOGI(kTag, "MQTT connect returned success");
    return true;
}

bool MqttProtocol::SendText(const std::string& text) {
    std::lock_guard<std::mutex> lock(send_mutex_);
    if (!mqtt_ || publish_topic_.empty()) {
        SetError("MQTT 未连接");
        return false;
    }
    ESP_LOGI(kTag, "MQTT tx: topic=%s bytes=%u %s",
             publish_topic_.c_str(),
             static_cast<unsigned>(text.size()),
             LogPayloadSummary(text).c_str());
    if (!mqtt_->Publish(publish_topic_, text)) {
        ESP_LOGW(kTag, "MQTT publish failed: connected=%d last_error=%d",
                 mqtt_->IsConnected() ? 1 : 0,
                 mqtt_->GetLastError());
        SetError("发送小智消息失败");
        return false;
    }
    ESP_LOGI(kTag, "MQTT publish ok");
    return true;
}

bool MqttProtocol::OpenAudioChannel() {
    if (!mqtt_ || !mqtt_->IsConnected()) {
        if (!StartMqttClient(true))
            return false;
    }

    error_occurred_ = false;
    mcp_accepting_.store(true, std::memory_order_relaxed);
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    session_id_.clear();
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        channel_open_notified_ = false;
        udp_.reset();
    }
    xEventGroupClearBits(event_group_, kServerHelloEvent | kServerGoodbyeEvent | kChannelClosedEvent);
    if (IsAudioChannelCloseRequested())
        return false;

    const std::string hello = GetHelloMessage();
    ESP_LOGI(kTag, "Opening MQTT audio channel, send hello");
    if (!SendText(hello))
        return false;

    ESP_LOGI(kTag, "Waiting MQTT server hello");
    const EventBits_t bits =
        xEventGroupWaitBits(event_group_,
                            kServerHelloEvent | kServerGoodbyeEvent | kChannelClosedEvent,
                            pdTRUE,
                            pdFALSE,
                            pdMS_TO_TICKS(10000));
    if (bits & kServerGoodbyeEvent) {
        if (IsAudioChannelCloseRequested())
            return false;
        ESP_LOGW(kTag, "MQTT server closed before hello: connected=%d session_id=%s udp=%s:%d nonce_len=%u",
                 mqtt_ && mqtt_->IsConnected() ? 1 : 0,
                 session_id_.c_str(),
                 udp_server_.c_str(),
                 udp_port_,
                 static_cast<unsigned>(aes_nonce_.size()));
        ESP_LOGW(kTag, "Clear cached Xiaozhi protocol config after pre-hello goodbye; next attempt will refetch OTA config");
        settings::ClearMqtt();
        settings::ClearWebsocket();
        SetError("小智服务器关闭连接");
        return false;
    }
    if (bits & kChannelClosedEvent) {
        if (!IsAudioChannelCloseRequested())
            SetError("小智 MQTT 连接已断开");
        return false;
    }
    if (!(bits & kServerHelloEvent)) {
        ESP_LOGW(kTag, "MQTT server hello timeout: connected=%d session_id=%s udp=%s:%d nonce_len=%u",
                 mqtt_ && mqtt_->IsConnected() ? 1 : 0,
                 session_id_.c_str(),
                 udp_server_.c_str(),
                 udp_port_,
                 static_cast<unsigned>(aes_nonce_.size()));
        SetError("小智服务器响应超时");
        return false;
    }
    if (IsAudioChannelCloseRequested())
        return false;

    EspNetwork network;
    auto udp = network.CreateUdp(2);
    if (!udp) {
        SetError("小智音频通道初始化失败");
        return false;
    }
    udp->OnMessage([this](const std::string& data) {
        constexpr size_t kNonceSize = 16;
        if (aes_nonce_.size() != kNonceSize || data.size() < kNonceSize || data[0] != 0x01) {
            ESP_LOGW(kTag, "UDP rx invalid header: bytes=%u nonce_len=%u first=0x%02x",
                     static_cast<unsigned>(data.size()),
                     static_cast<unsigned>(aes_nonce_.size()),
                     data.empty() ? 0 : static_cast<unsigned char>(data[0]));
            return;
        }

        const uint16_t declared_payload_size = ReadBe16(data.data() + 2);
        const uint32_t timestamp = ReadBe32(data.data() + 8);
        const uint32_t sequence = ReadBe32(data.data() + 12);
        if (sequence < remote_sequence_) {
            ESP_LOGW(kTag, "UDP rx old sequence=%lu remote=%lu",
                     static_cast<unsigned long>(sequence),
                     static_cast<unsigned long>(remote_sequence_));
            return;
        }

        const size_t payload_size = data.size() - kNonceSize;
        if (declared_payload_size != payload_size) {
            ESP_LOGW(kTag, "UDP rx payload size mismatch declared=%u actual=%u",
                     declared_payload_size,
                     static_cast<unsigned>(payload_size));
            return;
        }
        auto packet = std::make_unique<AudioStreamPacket>();
        packet->sample_rate = server_sample_rate_;
        packet->frame_duration = server_frame_duration_;
        packet->timestamp = timestamp;
        packet->payload.resize(payload_size);

        size_t nc_off = 0;
        uint8_t stream_block[16] = {0};
        std::array<uint8_t, kNonceSize> nonce{};
        std::memcpy(nonce.data(), data.data(), nonce.size());
        auto encrypted = reinterpret_cast<const uint8_t*>(data.data() + kNonceSize);
        int ret = mbedtls_aes_crypt_ctr(&aes_ctx_, payload_size, &nc_off, nonce.data(), stream_block,
                                        encrypted, packet->payload.data());
        if (ret == 0 && on_incoming_audio_) {
            on_incoming_audio_(std::move(packet));
        } else if (ret != 0) {
            ESP_LOGW(kTag, "UDP decrypt failed: ret=%d", ret);
        }
        remote_sequence_ = sequence;
        last_incoming_time_ = std::chrono::steady_clock::now();
    });
    ESP_LOGI(kTag, "Connect UDP %s:%d", udp_server_.c_str(), udp_port_);
    if (!udp->Connect(udp_server_, udp_port_)) {
        SetError("连接小智音频通道失败");
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (IsAudioChannelCloseRequested())
            return false;
        udp_ = std::move(udp);
        channel_open_notified_ = true;
        audio_channel_ready_.store(true, std::memory_order_relaxed);
    }
    if (on_audio_channel_opened_)
        on_audio_channel_opened_();
    return true;
}

void MqttProtocol::CloseAudioChannel(bool send_goodbye) {
    MarkAudioChannelCloseRequested();
    if (event_group_)
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    mcp_accepting_.store(false, std::memory_order_relaxed);
    StopMcpSendTask();
    std::unique_ptr<Udp> udp;
    bool notify_closed = false;
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        notify_closed = channel_open_notified_;
        channel_open_notified_ = false;
        udp = std::move(udp_);
    }
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    udp.reset();
    if (send_goodbye && !session_id_.empty()) {
        SendText("{\"session_id\":\"" + session_id_ + "\",\"type\":\"goodbye\"}");
    }
    if (notify_closed && on_audio_channel_closed_)
        on_audio_channel_closed_();
}

bool MqttProtocol::IsAudioChannelOpened() const {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    return mqtt_ && mqtt_->IsConnected() && udp_ != nullptr && !error_occurred_ && !IsTimeout();
}

bool MqttProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!udp_ || !packet)
        return false;
    if (aes_nonce_.size() != 16 || packet->payload.size() > UINT16_MAX)
        return false;

    std::string nonce(aes_nonce_);
    WriteBe16(nonce.data() + 2, static_cast<uint16_t>(packet->payload.size()));
    WriteBe32(nonce.data() + 8, packet->timestamp);
    WriteBe32(nonce.data() + 12, ++local_sequence_);

    std::string encrypted;
    encrypted.resize(nonce.size() + packet->payload.size());
    std::memcpy(encrypted.data(), nonce.data(), nonce.size());

    size_t nc_off = 0;
    uint8_t stream_block[16] = {0};
    int ret = mbedtls_aes_crypt_ctr(&aes_ctx_, packet->payload.size(), &nc_off,
                                    reinterpret_cast<uint8_t*>(nonce.data()), stream_block,
                                    packet->payload.data(),
                                    reinterpret_cast<uint8_t*>(&encrypted[nonce.size()]));
    if (ret != 0)
        return false;
    return udp_->Send(encrypted) > 0;
}

std::string MqttProtocol::GetHelloMessage() const {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "hello");
    cJSON_AddNumberToObject(root, "version", 3);
    cJSON_AddStringToObject(root, "transport", "udp");
    cJSON* features = cJSON_CreateObject();
    cJSON_AddBoolToObject(features, "mcp", true);
    cJSON_AddItemToObject(root, "features", features);
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

void MqttProtocol::ParseServerHello(const cJSON* root) {
    cJSON* transport = cJSON_GetObjectItem(root, "transport");
    if (!cJSON_IsString(transport) || std::strcmp(transport->valuestring, "udp") != 0) {
        ESP_LOGW(kTag, "Server hello ignored: transport=%s",
                 cJSON_IsString(transport) ? transport->valuestring : "(missing)");
        return;
    }

    cJSON* sid = cJSON_GetObjectItem(root, "session_id");
    if (cJSON_IsString(sid))
        session_id_ = sid->valuestring;
    ESP_LOGI(kTag, "Server hello: session_id=%s", session_id_.c_str());

    cJSON* audio = cJSON_GetObjectItem(root, "audio_params");
    if (cJSON_IsObject(audio)) {
        cJSON* sample_rate = cJSON_GetObjectItem(audio, "sample_rate");
        cJSON* frame_duration = cJSON_GetObjectItem(audio, "frame_duration");
        if (cJSON_IsNumber(sample_rate))
            server_sample_rate_ = sample_rate->valueint;
        if (cJSON_IsNumber(frame_duration))
            server_frame_duration_ = frame_duration->valueint;
    }
    ESP_LOGI(kTag, "Server audio params: sample_rate=%d frame_duration=%d",
             server_sample_rate_,
             server_frame_duration_);

    cJSON* udp = cJSON_GetObjectItem(root, "udp");
    if (!cJSON_IsObject(udp)) {
        ESP_LOGW(kTag, "Server hello ignored: missing udp object");
        return;
    }
    cJSON* server = cJSON_GetObjectItem(udp, "server");
    cJSON* port = cJSON_GetObjectItem(udp, "port");
    cJSON* key = cJSON_GetObjectItem(udp, "key");
    cJSON* nonce = cJSON_GetObjectItem(udp, "nonce");
    if (!cJSON_IsString(server) || !cJSON_IsNumber(port) || !cJSON_IsString(key) || !cJSON_IsString(nonce)) {
        ESP_LOGW(kTag, "Server hello ignored: invalid udp fields server=%d port=%d key=%d nonce=%d",
                 cJSON_IsString(server) ? 1 : 0,
                 cJSON_IsNumber(port) ? 1 : 0,
                 cJSON_IsString(key) ? 1 : 0,
                 cJSON_IsString(nonce) ? 1 : 0);
        return;
    }

    udp_server_ = server->valuestring;
    udp_port_ = port->valueint;
    aes_nonce_ = DecodeHexString(nonce->valuestring);
    std::string aes_key = DecodeHexString(key->valuestring);
    ESP_LOGI(kTag, "Server UDP params: server=%s port=%d key_len=%u nonce_len=%u",
             udp_server_.c_str(),
             udp_port_,
             static_cast<unsigned>(aes_key.size()),
             static_cast<unsigned>(aes_nonce_.size()));
    if (aes_nonce_.size() != 16 || aes_key.size() != 16) {
        SetError("小智 UDP 加密参数无效");
        return;
    }
    if (mbedtls_aes_setkey_enc(&aes_ctx_, reinterpret_cast<const unsigned char*>(aes_key.data()), 128) != 0) {
        SetError("小智 UDP 密钥初始化失败");
        return;
    }
    local_sequence_ = 0;
    remote_sequence_ = 0;
    xEventGroupSetBits(event_group_, kServerHelloEvent);
}

std::string MqttProtocol::DecodeHexString(const std::string& hex) const {
    std::string out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        out.push_back(static_cast<char>((HexValue(hex[i]) << 4) | HexValue(hex[i + 1])));
    }
    return out;
}

}  // namespace xiaozhi
