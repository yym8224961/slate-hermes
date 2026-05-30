#include "xiaozhi/service/chat_service.h"

#include <esp_heap_caps.h>
#include <esp_log.h>

#include <algorithm>

#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/chat_phase.h"
#include "drivers/audio/audio_player.h"
#include "storage/nvs/volume_store.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

ChatService& ChatService::Get() {
    static ChatService s;
    return s;
}

bool ChatService::Start(AudioPlayer* player) {
    if (!player)
        return false;
    player_ = player;
    if (!tasks_.config_done_notify) {
        tasks_.config_done_notify = xSemaphoreCreateBinary();
        if (!tasks_.config_done_notify) {
            ESP_LOGE(kTag, "Config done semaphore create failed");
            return false;
        }
    }
    if (!AudioService::Get().Start(player_))
        return false;
    if (!tasks_.conversation_done_notify) {
        tasks_.conversation_done_notify = xSemaphoreCreateBinary();
        if (!tasks_.conversation_done_notify) {
            ESP_LOGE(kTag, "Conversation done semaphore create failed");
            return false;
        }
    }
    StartControlTask();
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume       = settings::GetVolume();
        snapshot_.has_protocol = settings::HasProtocolConfig();
    }
    started_.store(true, std::memory_order_relaxed);
    return true;
}

void ChatService::EnterMode() {
    in_mode_.store(true, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume       = settings::GetVolume();
        snapshot_.has_protocol = settings::HasProtocolConfig();
        snapshot_.messages.clear();
        snapshot_.user_text.clear();
        snapshot_.assistant_text.clear();
        ClearAlertLocked();
    }
    bool has_conversation_task = false;
    {
        std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
        has_conversation_task = HasConversationTaskLocked();
    }
    const ChatPhase phase = chat_phase_.load(std::memory_order_relaxed);
    if (has_conversation_task || ConversationBlocksSleep(phase)) {
        SetState(ChatState::kStopping, "小智正在收尾...");
    } else if (settings::HasProtocolConfig()) {
        SetState(ChatState::kReadyIdle, "小智待机");
    } else {
        StartConfigTask();
    }
}

void ChatService::LeaveMode() {
    in_mode_.store(false, std::memory_order_relaxed);
    if (chat_phase_.load(std::memory_order_relaxed) == ChatPhase::kStartPending)
        chat_phase_.store(ChatPhase::kStopping, std::memory_order_relaxed);
    StopConfigTask(true);
    StopConversation(true);
    const bool stopped = WaitForConversationStopped(3000);
    if (stopped)
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
    ESP_LOGI(kTag, "LeaveMode wait stopped=%d", stopped ? 1 : 0);
}

void ChatService::ToggleChat() {
    const ChatState state = CurrentState();
    ESP_LOGI(kTag, "ToggleChat state=%d", static_cast<int>(state));
    switch (state) {
        case ChatState::kReadyIdle:
        case ChatState::kError:
            if (settings::HasProtocolConfig()) {
                StartConversationTask();
            } else {
                StartConfigTask();
            }
            break;
        case ChatState::kListening:
        case ChatState::kConnecting:
            StopConversation(true);
            break;
        case ChatState::kSpeaking:
            InterruptSpeaking();
            break;
        case ChatState::kStopping:
            if (settings::HasProtocolConfig()) {
                chat_phase_.store(ChatPhase::kStartPending, std::memory_order_relaxed);
                SetState(ChatState::kStopping, "小智正在收尾...");
            }
            break;
        case ChatState::kCheckingConfig:
        case ChatState::kAwaitingActivation:
            break;
    }
}

void ChatService::StopConversation(bool send_goodbye) {
    ESP_LOGI(kTag, "StopConversation begin goodbye=%d", send_goodbye ? 1 : 0);
    const bool was_running = SetStoppingIfMayRun(chat_phase_);
    bool       has_task    = false;
    {
        std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
        has_task = HasConversationTaskLocked();
    }
    std::shared_ptr<Protocol> protocol;
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol = protocol_;
        protocol_.reset();
    }
    if (was_running || has_task || protocol) {
        const ChatPhase phase = chat_phase_.load(std::memory_order_relaxed);
        if (phase == ChatPhase::kIdle)
            chat_phase_.store(ChatPhase::kStopping, std::memory_order_relaxed);
        if (CurrentState() != ChatState::kError)
            SetState(ChatState::kStopping, "小智正在收尾...");
    }
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    if (protocol)
        protocol->CloseAudioChannel(send_goodbye);
    EndAudioSession();
    ESP_LOGI(kTag, "StopConversation end was_running=%d has_task=%d had_protocol=%d", was_running ? 1 : 0,
             has_task ? 1 : 0, protocol ? 1 : 0);
}

void ChatService::AdjustVolume(int delta) {
    const int level = std::clamp(settings::GetVolume() + delta, 0, vol::kMax);
    SetVolume(level);
}

void ChatService::SetVolume(int level) {
    level = std::clamp(level, 0, vol::kMax);
    settings::SetVolume(level);
    AudioService::Get().SetVolume(vol::ToCodec(level));
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = level;
    }
    PostChanged();
}

bool ChatService::BlocksSleep() const {
    return in_mode_.load(std::memory_order_relaxed) || config_running_.load(std::memory_order_relaxed) ||
           ConversationBlocksSleep(chat_phase_.load(std::memory_order_relaxed)) || AudioService::Get().IsActive();
}

void ChatService::SuspendForSleep() {
    in_mode_.store(false, std::memory_order_relaxed);
    chat_phase_.store(ChatPhase::kStopping, std::memory_order_relaxed);
    StopConfigTask(true);
    control_close_requested_.store(false, std::memory_order_relaxed);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    AudioService::Get().EnableVoiceProcessing(false);
    std::shared_ptr<Protocol> protocol;
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol = protocol_;
        protocol_.reset();
    }
    if (protocol)
        protocol->CloseAudioChannel(false);
    const bool stopped = WaitForConversationStopped(3000);
    EndAudioSession();
    if (stopped)
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
}

void ChatService::NotifyNetworkClosed(uint32_t conversation_token) {
    RequestControlClose(conversation_token);
}

void ChatService::StartConversationTask() {
    if (!started_.load(std::memory_order_relaxed))
        return;
    std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
    const ChatPhase             phase = chat_phase_.load(std::memory_order_relaxed);
    if (tasks_.conversation_task || ConversationStopOrRestartPending(phase)) {
        ESP_LOGI(kTag, "StartConversationTask queued task=%p phase=%d", tasks_.conversation_task,
                 static_cast<int>(phase));
        QueueConversationStartLocked();
        return;
    }
    ChatPhase expected = ChatPhase::kIdle;
    if (!chat_phase_.compare_exchange_strong(expected, ChatPhase::kStarting, std::memory_order_relaxed))
        return;
    if (tasks_.conversation_done_notify) {
        while (xSemaphoreTake(tasks_.conversation_done_notify, 0) == pdTRUE) {
        }
    }
    conversation_token_.fetch_add(1, std::memory_order_acq_rel);
    ESP_LOGI(kTag, "StartConversationTask create token=%lu",
             static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ConversationTaskEntry, "xiaozhi_conv", 10 * 1024, this, 4,
                                            &tasks_.conversation_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Conversation task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        tasks_.conversation_task = nullptr;
        if (tasks_.conversation_done_notify)
            xSemaphoreGive(tasks_.conversation_done_notify);
        SetError("小智对话任务启动失败");
    } else {
        ESP_LOGI(kTag, "StartConversationTask created task=%p", tasks_.conversation_task);
    }
}

bool ChatService::HasConversationTaskLocked() const {
    return tasks_.conversation_task != nullptr;
}

void ChatService::QueueConversationStartLocked() {
    ESP_LOGI(kTag, "QueueConversationStart");
    chat_phase_.store(ChatPhase::kStartPending, std::memory_order_relaxed);
    if (in_mode_.load(std::memory_order_relaxed) && CurrentState() != ChatState::kError)
        SetState(ChatState::kStopping, "小智正在收尾...");
}

bool ChatService::WaitForConversationStopped(int timeout_ms) {
    ESP_LOGI(kTag, "WaitForConversationStopped begin timeout=%d", timeout_ms);
    {
        std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
        const ChatPhase             phase = chat_phase_.load(std::memory_order_relaxed);
        if (!ConversationMayRun(phase) && !tasks_.conversation_task) {
            ESP_LOGI(kTag, "WaitForConversationStopped already stopped");
            return true;
        }
    }
    if (!tasks_.conversation_done_notify)
        return false;
    if (xSemaphoreTake(tasks_.conversation_done_notify, pdMS_TO_TICKS(timeout_ms)) == pdTRUE) {
        ESP_LOGI(kTag, "WaitForConversationStopped done");
        return true;
    }
    ESP_LOGW(kTag, "Timed out waiting for conversation task");
    return false;
}

void ChatService::InterruptSpeaking() {
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    std::shared_ptr<Protocol> protocol;
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol = protocol_;
    }
    if (protocol) {
        protocol->SendAbortSpeaking(AbortReason::kNone);
        protocol->SendStartListening(ListeningMode::kAutoStop);
    }
    AudioService::Get().ResetDecoder();
    AudioService::Get().EnableVoiceProcessing(true);
    SetState(ChatState::kListening, "聆听中");
}

void ChatService::EndAudioSession() {
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    AudioService::Get().EnableVoiceProcessing(false);
    if (AudioService::Get().IsActive()) {
        AudioService::Get().EndAndRestoreAlbumVolume(vol::GetAlbum());
    } else {
        AudioService::Get().ResetDecoder();
    }
}

}  // namespace xiaozhi
