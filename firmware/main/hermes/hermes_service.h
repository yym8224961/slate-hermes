#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class AudioPlayer;

namespace hermes {

enum class HermesState : int {
    kIdle = 0,
    kRecording,
    kSending,
    kThinking,
    kSpeaking,
    kError,
};

struct HermesMessage {
    std::string role;
    std::string text;
};

struct HermesSnapshot {
    HermesState                state = HermesState::kIdle;
    std::string                status;
    std::string                error;
    std::vector<HermesMessage> messages;
    int                        volume     = 5;
    int                        record_sec = 0;  // recording duration
};

class HermesService {
   public:
    static HermesService& Get();

    bool Start(AudioPlayer* player);
    bool IsStarted() const { return started_.load(std::memory_order_relaxed); }

    void EnterMode();
    void LeaveMode();

    // Toggle: idle → start recording; recording → stop & send
    void ToggleChat();

    void StopConversation();
    void AdjustVolume(int delta);
    void SetVolume(int level);

    bool BlocksSleep() const;
    void SuspendForSleep();

    HermesSnapshot Snapshot();

   private:
    HermesService() = default;

    void SetState(HermesState state, const std::string& status = "");
    void SetError(const std::string& error);
    void PostChanged();

    void StartRecording();
    void StopAndSend();
    void SendAudioToBackend(const std::vector<int16_t>& pcm);

    HermesState CurrentState() const;

    // Recording task
    static void RecordTaskEntry(void* arg);
    void        RecordTask();

    AudioPlayer*             player_ = nullptr;
    std::atomic<bool>        started_{false};
    std::atomic<bool>        in_mode_{false};
    std::atomic<bool>        recording_{false};
    std::atomic<bool>        record_stop_{false};

    // PCM buffer (accumulated during recording)
    mutable std::mutex        pcm_mutex_;
    std::vector<int16_t>      pcm_buffer_;

    TaskHandle_t              record_task_ = nullptr;

    mutable std::mutex        snapshot_mutex_;
    HermesSnapshot            snapshot_;

    // Volume store helper
    int  saved_volume_ = 5;
};

}  // namespace hermes
