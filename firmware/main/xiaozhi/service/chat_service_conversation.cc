#include "xiaozhi/service/chat_service.h"

#include <cJSON.h>
#include <esp_log.h>

#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/chat_phase.h"
#include "storage/nvs/volume_store.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

void ChatService::ConversationTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ConversationTask();
    bool signal_stopped = false;
    {
        std::lock_guard<std::mutex> task_lock(self->conversation_task_mutex_);
        if (self->tasks_.conversation_task == xTaskGetCurrentTaskHandle()) {
            self->tasks_.conversation_task = nullptr;
            signal_stopped                 = true;
        }
    }
    SetStoppingIfMayRun(self->chat_phase_);
    if (signal_stopped && self->tasks_.conversation_done_notify)
        xSemaphoreGive(self->tasks_.conversation_done_notify);
    if (signal_stopped)
        self->RequestConversationStoppedHandling();
    ESP_LOGI(kTag, "ConversationTaskEntry exit signal_stopped=%d", signal_stopped ? 1 : 0);
    vTaskDelete(nullptr);
}

void ChatService::ConversationTask() {
    const uint32_t token = conversation_token_.load(std::memory_order_acquire);
    ESP_LOGI(kTag, "ConversationTask begin token=%lu", static_cast<unsigned long>(token));
    if (!ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)))
        return;
    if (!settings::HasProtocolConfig()) {
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        StartConfigTask();
        return;
    }

    SetState(ChatState::kConnecting, "连接小智中...");
    auto protocol = CreatePreferredProtocol();
    if (!protocol) {
        SetStoppingIfMayRun(chat_phase_);
        SetError("未获取小智协议配置");
        return;
    }
    protocol->SetOwnerToken(token);
    ConfigureProtocolCallbacks(protocol.get());
    protocol->PrepareAudioChannelOpen();
    std::shared_ptr<Protocol> active_protocol = std::move(protocol);
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol_ = active_protocol;
    }

    bool opened = false;
    if (ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)) && in_mode_.load(std::memory_order_relaxed) &&
        active_protocol->Start()) {
        opened = active_protocol->OpenAudioChannel();
    }
    ESP_LOGI(kTag, "ConversationTask open result opened=%d phase=%d in_mode=%d", opened ? 1 : 0,
             static_cast<int>(chat_phase_.load(std::memory_order_relaxed)),
             in_mode_.load(std::memory_order_relaxed) ? 1 : 0);
    if (!opened || !ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)) ||
        !in_mode_.load(std::memory_order_relaxed)) {
        const bool cancelled = !ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)) ||
                               !in_mode_.load(std::memory_order_relaxed);
        if (!opened && !cancelled && CurrentState() != ChatState::kError)
            SetError("小智连接失败");
        StopConversation(false);
        return;
    }

    if (!AudioService::Get().Begin(vol::ToCodec(settings::GetVolume()))) {
        SetError("音频初始化失败");
        StopConversation(true);
        return;
    }

    if (!ConversationMayRun(chat_phase_.load(std::memory_order_relaxed))) {
        StopConversation(false);
        return;
    }
    chat_phase_.store(ChatPhase::kRunning, std::memory_order_relaxed);
    active_protocol->SendStartListening(ListeningMode::kAutoStop);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    AudioService::Get().EnableVoiceProcessing(true);
    SetState(ChatState::kListening, "聆听中");

    while (ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)) &&
           in_mode_.load(std::memory_order_relaxed)) {
        const bool channel_open = active_protocol->IsAudioChannelOpened();
        if (!channel_open)
            break;

        if (pending_listen_after_playback_.load(std::memory_order_relaxed) &&
            AudioService::Get().WaitForPlaybackQueueEmpty(0)) {
            active_protocol->SendStartListening(ListeningMode::kAutoStop);
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            AudioService::Get().EnableVoiceProcessing(true);
            SetState(ChatState::kListening, "聆听中");
        }

        bool sent = false;
        while (auto packet = AudioService::Get().PopPacketFromSendQueue()) {
            if (!active_protocol->SendAudio(std::move(packet)))
                break;
            sent = true;
        }
        if (!sent) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

    ESP_LOGI(kTag, "ConversationTask loop exit phase=%d in_mode=%d channel_open=%d",
             static_cast<int>(chat_phase_.load(std::memory_order_relaxed)),
             in_mode_.load(std::memory_order_relaxed) ? 1 : 0, active_protocol->IsAudioChannelOpened() ? 1 : 0);
    SetStoppingIfMayRun(chat_phase_);
    EndAudioSession();
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    bool close_channel = false;
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        if (protocol_ == active_protocol) {
            protocol_.reset();
            close_channel = true;
        }
    }
    if (close_channel)
        active_protocol->CloseAudioChannel(false);
    if (CurrentState() != ChatState::kError)
        SetState(ChatState::kStopping, "小智正在收尾...");
}

void ChatService::ConfigureProtocolCallbacks(Protocol* protocol) {
    const uint32_t token = protocol->owner_token();
    protocol->OnIncomingAudio([this, token](std::unique_ptr<AudioStreamPacket> packet) {
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        if (CurrentState() == ChatState::kSpeaking)
            AudioService::Get().PushPacketToDecodeQueue(std::move(packet));
    });
    protocol->OnIncomingJson([this, token](const cJSON* root) {
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        HandleIncomingJson(root);
    });
    protocol->OnAudioChannelClosed([this, token]() {
        ESP_LOGI(kTag, "OnAudioChannelClosed token=%lu current=%lu", static_cast<unsigned long>(token),
                 static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        SetStoppingIfMayRun(chat_phase_);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        AudioService::Get().EnableVoiceProcessing(false);
        AudioService::Get().ResetDecoder();
        if (CurrentState() != ChatState::kError)
            SetState(ChatState::kStopping, "小智正在收尾...");
    });
    protocol->OnNetworkError([this, token](const std::string& message) {
        ESP_LOGI(kTag, "OnNetworkError token=%lu current=%lu message=%s", static_cast<unsigned long>(token),
                 static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)), message.c_str());
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        SetStoppingIfMayRun(chat_phase_);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        AudioService::Get().EnableVoiceProcessing(false);
        AudioService::Get().ResetDecoder();
        SetError(message.empty() ? "小智网络异常" : message);
    });
}

}  // namespace xiaozhi
