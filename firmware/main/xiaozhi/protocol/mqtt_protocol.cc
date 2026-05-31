#include "xiaozhi/protocol/mqtt_protocol.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_network.h>

#include <array>
#include <cstring>
#include <string>

#include "utils/byte_utils.h"
#include "utils/json_utils.h"
#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "XiaoMQTT";

std::string JsonType(const cJSON* root) {
    cJSON* type = cJSON_GetObjectItem(root, "type");
    return cJSON_IsString(type) && type->valuestring ? type->valuestring : "";
}
}  // namespace

namespace xiaozhi {

MqttProtocol::MqttProtocol() {
    event_group_ = xEventGroupCreate();
    mbedtls_aes_init(&aes_encrypt_ctx_);
    mbedtls_aes_init(&aes_decrypt_ctx_);
}

MqttProtocol::~MqttProtocol() {
    *alive_ = false;
    StopMcpSendTask();
    CloseAudioChannel(false);
    mqtt_.reset();
    mbedtls_aes_free(&aes_encrypt_ctx_);
    mbedtls_aes_free(&aes_decrypt_ctx_);
    if (event_group_) {
        vEventGroupDelete(event_group_);
        event_group_ = nullptr;
    }
}

bool MqttProtocol::Start() {
    return StartMqttClient(false);
}

bool MqttProtocol::StartMqttClient(bool report_error) {
    ESP_LOGI(kTag, "StartMqttClient begin report_error=%d", report_error ? 1 : 0);
    std::shared_ptr<Mqtt> old_mqtt;
    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        old_mqtt = std::move(mqtt_);
    }
    old_mqtt.reset();

    settings::MqttConfig cfg;
    if (!settings::LoadMqtt(cfg)) {
        if (report_error)
            SetError("未获取 MQTT 配置");
        return false;
    }
    publish_topic_ = cfg.publish_topic;

    EspNetwork network;
    auto       mqtt_unique = network.CreateMqtt(0);
    if (!mqtt_unique) {
        if (report_error)
            SetError("小智 MQTT 初始化失败");
        return false;
    }
    std::shared_ptr<Mqtt> mqtt(std::move(mqtt_unique));
    mqtt->SetKeepAlive(cfg.keepalive);
    mqtt->OnConnected([this]() {
        if (on_connected_)
            on_connected_();
    });
    mqtt->OnDisconnected([this]() {
        ESP_LOGW(kTag, "MQTT disconnected");
        if (on_disconnected_)
            on_disconnected_();
        if (event_group_)
            xEventGroupSetBits(event_group_, kChannelClosedEvent);
        if (*alive_)
            PostChannelClosedEvent();
    });
    mqtt->OnError([this](const std::string& err) { ESP_LOGW(kTag, "MQTT error: %s", err.c_str()); });
    mqtt->OnMessage([this](const std::string& topic, const std::string& payload) {
        (void)topic;
        if (HandleMqttMessagePayload(payload))
            MarkIncomingNow();
    });

    std::string  host = cfg.endpoint;
    int          port = 8883;
    const size_t pos  = cfg.endpoint.find(':');
    if (pos != std::string::npos) {
        host = cfg.endpoint.substr(0, pos);
        port = std::atoi(cfg.endpoint.substr(pos + 1).c_str());
    }

    if (!mqtt->Connect(host, port, cfg.client_id, cfg.username, cfg.password)) {
        ESP_LOGW(kTag, "MQTT connect failed: last_error=%d", mqtt->GetLastError());
        if (report_error)
            SetError("连接小智服务器失败");
        return false;
    }
    std::lock_guard<std::mutex> lock(send_mutex_);
    if (IsAudioChannelCloseRequested()) {
        mqtt.reset();
        return false;
    }
    mqtt_ = std::move(mqtt);
    ESP_LOGI(kTag, "StartMqttClient connected");
    return true;
}

bool MqttProtocol::IsMqttConnected() const {
    std::lock_guard<std::mutex> lock(send_mutex_);
    return mqtt_ && mqtt_->IsConnected();
}

bool MqttProtocol::SendText(const std::string& text) {
    std::lock_guard<std::mutex> lock(send_mutex_);
    return SendTextLocked(text, true);
}

bool MqttProtocol::SendTextLocked(const std::string& text, bool report_error) {
    if (!mqtt_ || publish_topic_.empty()) {
        if (report_error)
            SetError("MQTT 未连接");
        return false;
    }
    if (!mqtt_->Publish(publish_topic_, text)) {
        ESP_LOGW(kTag, "MQTT publish failed: connected=%d last_error=%d", mqtt_->IsConnected() ? 1 : 0,
                 mqtt_->GetLastError());
        if (report_error)
            SetError("发送小智消息失败");
        return false;
    }
    return true;
}

bool MqttProtocol::OpenAudioChannel() {
    if (!IsMqttConnected()) {
        if (!StartMqttClient(true))
            return false;
    }

    error_occurred_.store(false, std::memory_order_release);
    mcp_accepting_.store(true, std::memory_order_relaxed);
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    ClearSessionId();
    ResetIncomingTimeout();
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        channel_open_notified_ = false;
        udp_.reset();
    }
    xEventGroupClearBits(event_group_, kServerHelloEvent | kServerGoodbyeEvent | kChannelClosedEvent);
    if (IsAudioChannelCloseRequested())
        return false;

    const std::string hello = GetHelloMessage();
    if (!SendText(hello))
        return false;

    const EventBits_t bits =
        xEventGroupWaitBits(event_group_, kServerHelloEvent | kServerGoodbyeEvent | kChannelClosedEvent, pdTRUE,
                            pdFALSE, pdMS_TO_TICKS(10000));
    if (bits & kServerGoodbyeEvent) {
        if (IsAudioChannelCloseRequested())
            return false;
        ESP_LOGW(kTag, "MQTT server closed before hello: connected=%d", IsMqttConnected() ? 1 : 0);
        ESP_LOGW(kTag, "Clear cached Xiaozhi MQTT config after pre-hello goodbye");
        settings::ClearMqtt();
        SetError("小智服务器关闭连接");
        return false;
    }
    if (bits & kChannelClosedEvent) {
        // ParseServerHello 失败时已 SetError 具体原因,这里只在还未设过 error 时
        // 兜底报"连接已断开",避免覆盖具体诊断信息。
        if (!IsAudioChannelCloseRequested() && !error_occurred_.load(std::memory_order_acquire))
            SetError("小智 MQTT 连接已断开");
        return false;
    }
    if (!(bits & kServerHelloEvent)) {
        ESP_LOGW(kTag, "MQTT server hello timeout: connected=%d", IsMqttConnected() ? 1 : 0);
        SetError("小智服务器响应超时");
        return false;
    }
    if (IsAudioChannelCloseRequested())
        return false;

    EspNetwork network;
    auto       udp = network.CreateUdp(2);
    if (!udp) {
        SetError("小智音频通道初始化失败");
        return false;
    }
    udp->OnMessage([this](const std::string& data) {
        if (HandleUdpPacket(data))
            MarkIncomingNow();
    });
    std::string udp_server;
    int         udp_port = 0;
    {
        std::lock_guard<std::mutex> lock(crypto_mutex_);
        udp_server = udp_server_;
        udp_port   = udp_port_;
    }
    if (!udp->Connect(udp_server, udp_port)) {
        SetError("连接小智音频通道失败");
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        if (IsAudioChannelCloseRequested())
            return false;
        udp_                   = std::move(udp);
        channel_open_notified_ = true;
        audio_channel_ready_.store(true, std::memory_order_relaxed);
    }
    if (on_audio_channel_opened_)
        on_audio_channel_opened_();
    return true;
}

void MqttProtocol::CloseAudioChannel(bool send_goodbye) {
    ESP_LOGI(kTag, "CloseAudioChannel begin goodbye=%d", send_goodbye ? 1 : 0);
    MarkAudioChannelCloseRequested();
    if (event_group_)
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    mcp_accepting_.store(false, std::memory_order_relaxed);
    StopMcpSendTask();
    std::unique_ptr<Udp> udp;
    bool                 notify_closed = false;
    {
        std::lock_guard<std::mutex> lock(channel_mutex_);
        notify_closed          = channel_open_notified_;
        channel_open_notified_ = false;
        udp                    = std::move(udp_);
    }
    audio_channel_ready_.store(false, std::memory_order_relaxed);
    udp.reset();
    const std::string session_id = SessionIdCopy();
    if (send_goodbye && !session_id.empty()) {
        std::lock_guard<std::mutex> lock(send_mutex_);
        SendTextLocked("{\"session_id\":" + json_utils::JsonStringLiteral(session_id) + ",\"type\":\"goodbye\"}",
                       false);
    }
    std::shared_ptr<Mqtt> mqtt;
    {
        std::lock_guard<std::mutex> lock(send_mutex_);
        mqtt = std::move(mqtt_);
    }
    if (mqtt)
        mqtt->Disconnect();
    mqtt.reset();
    if (notify_closed && on_audio_channel_closed_)
        on_audio_channel_closed_();
    ESP_LOGI(kTag, "CloseAudioChannel end notify_closed=%d", notify_closed ? 1 : 0);
}

bool MqttProtocol::IsAudioChannelOpened() const {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    return udp_ != nullptr && IsMqttConnected() && !error_occurred_.load(std::memory_order_acquire) && !IsTimeout();
}

bool MqttProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    std::lock_guard<std::mutex> lock(channel_mutex_);
    if (!udp_ || !packet)
        return false;
    std::lock_guard<std::mutex> crypto_lock(crypto_mutex_);
    if (aes_nonce_.size() != 16 || packet->payload.size() > UINT16_MAX)
        return false;

    std::string nonce(aes_nonce_);
    util::WriteBe16(nonce.data() + 2, static_cast<uint16_t>(packet->payload.size()));
    util::WriteBe32(nonce.data() + 8, packet->timestamp);
    util::WriteBe32(nonce.data() + 12, ++local_sequence_);

    std::string encrypted;
    encrypted.resize(nonce.size() + packet->payload.size());
    std::memcpy(encrypted.data(), nonce.data(), nonce.size());

    size_t  nc_off           = 0;
    uint8_t stream_block[16] = {0};
    int     ret              = mbedtls_aes_crypt_ctr(&aes_encrypt_ctx_, packet->payload.size(), &nc_off,
                                                     reinterpret_cast<uint8_t*>(nonce.data()), stream_block, packet->payload.data(),
                                                     reinterpret_cast<uint8_t*>(&encrypted[nonce.size()]));
    if (ret != 0)
        return false;
    return udp_->Send(encrypted) > 0;
}

bool MqttProtocol::HandleMqttMessagePayload(const std::string& payload) {
    cJSON* root = cJSON_Parse(payload.c_str());
    if (!root) {
        ESP_LOGW(kTag, "MQTT rx ignored: invalid JSON");
        return false;
    }

    const std::string type = JsonType(root);
    if (type.empty()) {
        ESP_LOGW(kTag, "MQTT rx ignored: missing type");
    } else if (type == "hello") {
        ParseServerHello(root);
    } else if (type == "goodbye") {
        cJSON*            sid                = cJSON_GetObjectItem(root, "session_id");
        const std::string current_session_id = SessionIdCopy();
        if (!cJSON_IsString(sid) || current_session_id == sid->valuestring) {
            mcp_accepting_.store(false, std::memory_order_relaxed);
            xEventGroupSetBits(event_group_, kServerGoodbyeEvent);
            PostChannelClosedEvent();
        }
    } else if (type == "mcp" && HandleMcpMessage(root)) {
    } else if (on_incoming_json_) {
        on_incoming_json_(root);
    }
    cJSON_Delete(root);
    return true;
}

bool MqttProtocol::HandleUdpPacket(const std::string& data) {
    constexpr size_t            kNonceSize = 16;
    std::lock_guard<std::mutex> lock(crypto_mutex_);
    const size_t                nonce_len = aes_nonce_.size();
    if (nonce_len != kNonceSize || data.size() <= kNonceSize || data[0] != 0x01) {
        ESP_LOGW(kTag, "UDP rx invalid packet: bytes=%u nonce_len=%u first=0x%02x", static_cast<unsigned>(data.size()),
                 static_cast<unsigned>(nonce_len), data.empty() ? 0 : static_cast<unsigned char>(data[0]));
        return false;
    }

    const uint16_t declared_payload_size = util::ReadBe16(data.data() + 2);
    const uint32_t timestamp             = util::ReadBe32(data.data() + 8);
    const uint32_t sequence              = util::ReadBe32(data.data() + 12);
    if (sequence < remote_sequence_) {
        ESP_LOGW(kTag, "UDP rx old sequence=%lu remote=%lu", static_cast<unsigned long>(sequence),
                 static_cast<unsigned long>(remote_sequence_));
        return false;
    }

    const size_t payload_size = data.size() - kNonceSize;
    if (declared_payload_size != payload_size) {
        ESP_LOGW(kTag, "UDP rx payload size mismatch declared=%u actual=%u", declared_payload_size,
                 static_cast<unsigned>(payload_size));
        return false;
    }

    int sample_rate    = 0;
    int frame_duration = 0;
    GetServerAudioParams(sample_rate, frame_duration);
    auto packet            = std::make_unique<AudioStreamPacket>();
    packet->sample_rate    = sample_rate;
    packet->frame_duration = frame_duration;
    packet->timestamp      = timestamp;
    packet->payload.resize(payload_size);

    size_t                          nc_off           = 0;
    uint8_t                         stream_block[16] = {0};
    std::array<uint8_t, kNonceSize> nonce{};
    std::memcpy(nonce.data(), data.data(), nonce.size());
    auto encrypted = reinterpret_cast<const uint8_t*>(data.data() + kNonceSize);
    int  ret = mbedtls_aes_crypt_ctr(&aes_decrypt_ctx_, payload_size, &nc_off, nonce.data(), stream_block, encrypted,
                                     packet->payload.data());
    if (ret == 0 && on_incoming_audio_) {
        on_incoming_audio_(std::move(packet));
    } else if (ret != 0) {
        ESP_LOGW(kTag, "UDP decrypt failed: ret=%d", ret);
    }
    remote_sequence_ = sequence;
    return true;
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
    return json_utils::PrintAndDelete(root);
}

void MqttProtocol::ParseServerHello(const cJSON* root) {
    // 失败路径走 SetError + setBits(kChannelClosedEvent),让 OpenAudioChannel 立刻
    // 退出等待并保留具体错误原因,不再等满 10s 才报"响应超时"。
    auto fail = [this](const char* reason) {
        SetError(reason);
        xEventGroupSetBits(event_group_, kChannelClosedEvent);
    };
    cJSON* transport = cJSON_GetObjectItem(root, "transport");
    if (!cJSON_IsString(transport) || std::strcmp(transport->valuestring, "udp") != 0) {
        ESP_LOGW(kTag, "Server hello ignored: transport=%s",
                 cJSON_IsString(transport) ? transport->valuestring : "(missing)");
        fail("小智 MQTT 协议不匹配");
        return;
    }

    cJSON* sid = cJSON_GetObjectItem(root, "session_id");
    if (cJSON_IsString(sid))
        SetSessionId(sid->valuestring);

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
                fail("小智 MQTT 音频采样率不支持");
                return;
            }
            sample_rate = sample_rate_item->valueint;
        }
        if (cJSON_IsNumber(frame_duration_item)) {
            if (!IsSupportedOpusFrameDuration(frame_duration_item->valueint)) {
                ESP_LOGW(kTag, "Server hello ignored: invalid frame_duration=%d", frame_duration_item->valueint);
                fail("小智 MQTT 音频帧长不支持");
                return;
            }
            frame_duration = frame_duration_item->valueint;
        }
    }

    cJSON* udp = cJSON_GetObjectItem(root, "udp");
    if (!cJSON_IsObject(udp)) {
        ESP_LOGW(kTag, "Server hello ignored: missing udp object");
        fail("小智 MQTT 缺少 UDP 配置");
        return;
    }
    cJSON* server = cJSON_GetObjectItem(udp, "server");
    cJSON* port   = cJSON_GetObjectItem(udp, "port");
    cJSON* key    = cJSON_GetObjectItem(udp, "key");
    cJSON* nonce  = cJSON_GetObjectItem(udp, "nonce");
    if (!cJSON_IsString(server) || !server->valuestring || server->valuestring[0] == '\0' || !cJSON_IsNumber(port) ||
        port->valueint <= 0 || port->valueint > 65535 || !cJSON_IsString(key) || !cJSON_IsString(nonce)) {
        ESP_LOGW(kTag, "Server hello ignored: invalid udp fields server=%d port=%d key=%d nonce=%d",
                 cJSON_IsString(server) && server->valuestring && server->valuestring[0] != '\0' ? 1 : 0,
                 cJSON_IsNumber(port) && port->valueint > 0 && port->valueint <= 65535 ? 1 : 0,
                 cJSON_IsString(key) ? 1 : 0, cJSON_IsString(nonce) ? 1 : 0);
        fail("小智 MQTT UDP 字段无效");
        return;
    }

    std::string aes_key   = DecodeHexString(key->valuestring);
    std::string aes_nonce = DecodeHexString(nonce->valuestring);
    if (aes_nonce.size() != 16 || aes_key.size() != 16) {
        fail("小智 UDP 加密参数无效");
        return;
    }
    std::lock_guard<std::mutex> lock(crypto_mutex_);
    udp_server_ = server->valuestring;
    udp_port_   = port->valueint;
    aes_nonce_  = std::move(aes_nonce);
    if (mbedtls_aes_setkey_enc(&aes_encrypt_ctx_, reinterpret_cast<const unsigned char*>(aes_key.data()), 128) != 0 ||
        mbedtls_aes_setkey_enc(&aes_decrypt_ctx_, reinterpret_cast<const unsigned char*>(aes_key.data()), 128) != 0) {
        fail("小智 UDP 密钥初始化失败");
        return;
    }
    SetServerAudioParams(sample_rate, frame_duration);
    local_sequence_  = 0;
    remote_sequence_ = 0;
    xEventGroupSetBits(event_group_, kServerHelloEvent);
}

std::string MqttProtocol::DecodeHexString(const std::string& hex) const {
    std::string out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        out.push_back(static_cast<char>((util::HexValue(hex[i]) << 4) | util::HexValue(hex[i + 1])));
    }
    return out;
}

}  // namespace xiaozhi
