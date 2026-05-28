#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <web_socket.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>

#include "xiaozhi_protocol.h"

class EspNetwork;

namespace xiaozhi {

class WebsocketProtocol : public Protocol {
   public:
    WebsocketProtocol();
    ~WebsocketProtocol() override;

    bool Start() override;
    bool OpenAudioChannel() override;
    void CloseAudioChannel(bool send_goodbye = true) override;
    bool IsAudioChannelOpened() const override;
    bool SendAudio(std::unique_ptr<AudioStreamPacket> packet) override;

   private:
    static constexpr EventBits_t kServerHelloEvent   = BIT0;
    static constexpr EventBits_t kChannelClosedEvent = BIT1;

    EventGroupHandle_t          event_group_ = nullptr;
    std::unique_ptr<EspNetwork> network_;
    std::unique_ptr<WebSocket>  websocket_;
    mutable std::mutex          channel_mutex_;
    bool                        channel_open_notified_ = false;
    std::atomic<int>            version_{1};
    std::string                 send_buffer_;

    bool        SendText(const std::string& text) override;
    std::string GetHelloMessage() const;
    void        ParseServerHello(const cJSON* root);
};

}  // namespace xiaozhi
