#pragma once

#include <cJSON.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace xiaozhi {

constexpr int kOpusFrameDurationMs = 60;
constexpr int kClientSampleRate    = 16000;

struct AudioStreamPacket {
    int sample_rate    = 0;
    int frame_duration = 0;
    uint32_t timestamp = 0;
    uint32_t epoch     = 0;
    std::vector<uint8_t> payload;
};

struct BinaryProtocol2 {
    uint16_t version;
    uint16_t type;
    uint32_t reserved;
    uint32_t timestamp;
    uint32_t payload_size;
    uint8_t payload[];
} __attribute__((packed));

struct BinaryProtocol3 {
    uint8_t type;
    uint8_t reserved;
    uint16_t payload_size;
    uint8_t payload[];
} __attribute__((packed));

enum class ListeningMode {
    kAutoStop,
    kManualStop,
};

enum class AbortReason {
    kNone,
    kWakeWordDetected,
};

class Protocol {
   public:
    virtual ~Protocol();

    int server_sample_rate() const {
        return server_sample_rate_;
    }
    int server_frame_duration() const {
        return server_frame_duration_;
    }
    const std::string& session_id() const {
        return session_id_;
    }
    uint32_t owner_token() const {
        return owner_token_;
    }
    void SetOwnerToken(uint32_t token) {
        owner_token_ = token;
    }
    void PrepareAudioChannelOpen();

    void OnIncomingAudio(std::function<void(std::unique_ptr<AudioStreamPacket>)> cb);
    void OnIncomingJson(std::function<void(const cJSON*)> cb);
    void OnAudioChannelOpened(std::function<void()> cb);
    void OnAudioChannelClosed(std::function<void()> cb);
    void OnNetworkError(std::function<void(const std::string&)> cb);
    void OnConnected(std::function<void()> cb);
    void OnDisconnected(std::function<void()> cb);

    virtual bool Start() = 0;
    virtual bool OpenAudioChannel() = 0;
    virtual void CloseAudioChannel(bool send_goodbye = true) = 0;
    virtual bool IsAudioChannelOpened() const = 0;
    virtual bool SendAudio(std::unique_ptr<AudioStreamPacket> packet) = 0;

    void SendStartListening(ListeningMode mode);
    void SendStopListening();
    void SendAbortSpeaking(AbortReason reason);
    void SendMcpMessage(const std::string& payload);

   protected:
    std::function<void(const cJSON*)> on_incoming_json_;
    std::function<void(std::unique_ptr<AudioStreamPacket>)> on_incoming_audio_;
    std::function<void()> on_audio_channel_opened_;
    std::function<void()> on_audio_channel_closed_;
    std::function<void(const std::string&)> on_network_error_;
    std::function<void()> on_connected_;
    std::function<void()> on_disconnected_;

    QueueHandle_t mcp_send_queue_ = nullptr;
    TaskHandle_t mcp_send_task_ = nullptr;
    TaskHandle_t mcp_stop_waiter_ = nullptr;
    mutable std::mutex mcp_mutex_;
    std::atomic<bool> mcp_accepting_{true};
    int server_sample_rate_    = 24000;
    int server_frame_duration_ = kOpusFrameDurationMs;
    uint32_t owner_token_      = 0;
    bool error_occurred_       = false;
    std::atomic<bool> audio_channel_ready_{false};
    std::atomic<bool> audio_channel_close_requested_{false};
    std::string session_id_;
    std::chrono::time_point<std::chrono::steady_clock> last_incoming_time_ = std::chrono::steady_clock::now();

    virtual bool SendText(const std::string& text) = 0;
    void SetError(const std::string& message);
    void MarkAudioChannelCloseRequested();
    bool IsAudioChannelCloseRequested() const;
    bool StartMcpSendTaskLocked();
    void StopMcpSendTask();
    bool HandleMcpMessage(const cJSON* root);
    bool IsTimeout() const;

   private:
    static void McpSendTaskEntry(void* arg);
    void McpSendTask();
};

std::unique_ptr<Protocol> CreatePreferredProtocol();

}  // namespace xiaozhi
