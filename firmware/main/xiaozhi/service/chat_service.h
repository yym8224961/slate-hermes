#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "xiaozhi/protocol/protocol.h"

class AudioPlayer;

namespace xiaozhi {

class AudioService;

enum class ChatState : int {
    kCheckingConfig = 0,
    kAwaitingActivation,
    kReadyIdle,
    kConnecting,
    kListening,
    kSpeaking,
    kStopping,
    kError,
};

enum class ChatPhase : uint8_t {
    kIdle,
    kStarting,
    kRunning,
    kStopping,
    kStartPending,
};

struct ChatMessage {
    std::string role;
    std::string text;
};

struct ChatSnapshot {
    ChatState                state = ChatState::kCheckingConfig;
    std::string              status;
    std::string              emotion = "neutral";
    std::string              activation_message;
    std::string              activation_code;
    std::string              user_text;
    std::string              assistant_text;
    std::vector<ChatMessage> messages;
    bool                     alert_active = false;
    std::string              alert_status;
    std::string              alert_message;
    std::string              alert_emotion;
    std::string              error;
    int                      volume       = 0;
    bool                     has_protocol = false;
};

class ChatService {
   public:
    static ChatService& Get();

    bool Start(AudioPlayer* player, AudioService* audio);
    bool IsStarted() const {
        return started_.load(std::memory_order_relaxed);
    }
    void EnterMode();
    void LeaveMode();
    void ToggleChat();
    void StopConversation(bool send_goodbye = true);
    void AdjustVolume(int delta);
    void PreviewVolume(int level);
    void SetVolume(int level);
    bool BlocksSleep() const;
    void SuspendForSleep();
    void NotifyNetworkClosed(uint32_t conversation_token);

    ChatSnapshot Snapshot();

   private:
    ChatService() = default;

    struct TaskGroup {
        SemaphoreHandle_t config_done_notify       = nullptr;
        SemaphoreHandle_t conversation_done_notify = nullptr;
        SemaphoreHandle_t control_notify           = nullptr;
        TaskHandle_t      config_task              = nullptr;
        TaskHandle_t      conversation_task        = nullptr;
        TaskHandle_t      control_task             = nullptr;
    };

    static void ConfigTaskEntry(void* arg);
    static void ConversationTaskEntry(void* arg);
    static void ControlTaskEntry(void* arg);
    void        ConfigTask();
    void        ConversationTask();
    void        ControlTask();

    void      StartConfigTask();
    void      StartConversationTask();
    void      StartControlTask();
    bool      HasConversationTaskLocked() const;
    void      QueueConversationStartLocked();
    void      MaybeStartPendingConversation();
    void      RequestControlClose(uint32_t conversation_token);
    void      RequestConversationStoppedHandling();
    void      StopConfigTask(bool wait);
    void      SignalConfigTaskStopped();
    bool      WaitForConversationStopped(int timeout_ms);
    void      ConfigureProtocolCallbacks(Protocol* protocol);
    void      HandleIncomingJson(const cJSON* root);
    void      InterruptSpeaking();
    void      EndAudioSession();
    void      SetState(ChatState state, const std::string& status = "");
    void      SetError(const std::string& error);
    void      SetActivation(const std::string& message, const std::string& code);
    void      SetUserText(const std::string& text);
    void      SetAssistantText(const std::string& text);
    void      SetAlert(const std::string& status, const std::string& message, const std::string& emotion);
    void      ClearAlertLocked();
    void      TrimMessagesLocked();
    ChatState CurrentState();
    void      PostChanged();

    AudioPlayer*           player_ = nullptr;
    AudioService*          audio_  = nullptr;
    std::atomic<bool>      started_{false};
    std::atomic<bool>      in_mode_{false};
    std::atomic<bool>      config_running_{false};
    std::atomic<bool>      config_stop_requested_{false};
    std::atomic<ChatPhase> chat_phase_{ChatPhase::kIdle};
    std::atomic<bool>      pending_listen_after_playback_{false};
    std::atomic<bool>      control_running_{false};
    std::atomic<bool>      control_close_requested_{false};
    std::atomic<bool>      control_conversation_stopped_{false};
    std::atomic<uint32_t>  conversation_token_{0};
    std::atomic<uint32_t>  control_close_token_{0};

    std::mutex   snapshot_mutex_;
    ChatSnapshot snapshot_;

    std::mutex                protocol_mutex_;
    std::shared_ptr<Protocol> protocol_;
    std::mutex                config_task_mutex_;
    std::mutex                conversation_task_mutex_;
    TaskGroup                 tasks_;
};

}  // namespace xiaozhi
