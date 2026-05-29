#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <mbedtls/aes.h>
#include <mqtt.h>
#include <udp.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>

#include "xiaozhi_protocol.h"

namespace xiaozhi {

class MqttProtocol : public Protocol {
   public:
    MqttProtocol();
    ~MqttProtocol() override;

    bool Start() override;
    bool OpenAudioChannel() override;
    void CloseAudioChannel(bool send_goodbye = true) override;
    bool IsAudioChannelOpened() const override;
    bool SendAudio(std::unique_ptr<AudioStreamPacket> packet) override;

   private:
    static constexpr EventBits_t       kServerHelloEvent   = BIT0;
    static constexpr EventBits_t       kServerGoodbyeEvent = BIT1;
    static constexpr EventBits_t       kChannelClosedEvent = BIT2;
    std::shared_ptr<std::atomic<bool>> alive_              = std::make_shared<std::atomic<bool>>(true);
    EventGroupHandle_t                 event_group_        = nullptr;
    std::shared_ptr<Mqtt>              mqtt_;
    std::unique_ptr<Udp>               udp_;
    mutable std::mutex                 send_mutex_;
    mutable std::mutex                 channel_mutex_;
    bool                               channel_open_notified_ = false;
    std::string                        publish_topic_;
    std::string                        aes_nonce_;
    std::string                        udp_server_;
    int                                udp_port_        = 0;
    uint32_t                           local_sequence_  = 0;
    uint32_t                           remote_sequence_ = 0;
    mutable std::mutex                 crypto_mutex_;
    mbedtls_aes_context                aes_encrypt_ctx_;
    mbedtls_aes_context                aes_decrypt_ctx_;

    bool        StartMqttClient(bool report_error);
    bool        IsMqttConnected() const;
    bool        SendText(const std::string& text) override;
    bool        SendTextLocked(const std::string& text, bool report_error);
    std::string GetHelloMessage() const;
    void        ParseServerHello(const cJSON* root);
    std::string DecodeHexString(const std::string& hex) const;
};

}  // namespace xiaozhi
