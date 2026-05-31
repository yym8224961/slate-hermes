#include "xiaozhi/service/chat_service.h"

#include <cJSON.h>
#include <esp_heap_caps.h>
#include <esp_log.h>

#include <algorithm>

#include "drivers/audio/audio_player.h"
#include "events/event_bus.h"
#include "storage/nvs/volume_store.h"
#include "xiaozhi/config/activation_client.h"
#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/chat_phase.h"
#include "xiaozhi/service/message_handler.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

ChatService& ChatService::Get() {
    static ChatService s;
    return s;
}

bool ChatService::Start(AudioPlayer* player, AudioService* audio) {
    if (!player || !audio)
        return false;
    player_ = player;
    audio_  = audio;
    if (!tasks_.config_done_notify) {
        tasks_.config_done_notify = xSemaphoreCreateBinary();
        if (!tasks_.config_done_notify) {
            ESP_LOGE(kTag, "Config done semaphore create failed");
            return false;
        }
    }
    if (!audio_->Start(player_))
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

void ChatService::PreviewVolume(int level) {
    level = std::clamp(level, 0, vol::kMax);
    if (player_)
        player_->SetVolume(vol::ToCodec(level));
}

void ChatService::SetVolume(int level) {
    level = std::clamp(level, 0, vol::kMax);
    settings::SetVolume(level);
    PreviewVolume(level);
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = level;
    }
    PostChanged();
}

bool ChatService::BlocksSleep() const {
    const bool audio_active = audio_ && audio_->IsActive();
    return in_mode_.load(std::memory_order_relaxed) || config_running_.load(std::memory_order_relaxed) ||
           ConversationBlocksSleep(chat_phase_.load(std::memory_order_relaxed)) || audio_active;
}

void ChatService::SuspendForSleep() {
    in_mode_.store(false, std::memory_order_relaxed);
    chat_phase_.store(ChatPhase::kStopping, std::memory_order_relaxed);
    StopConfigTask(true);
    control_close_requested_.store(false, std::memory_order_relaxed);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    if (audio_)
        audio_->EnableVoiceProcessing(false);
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
    if (!audio_)
        return;
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
    audio_->ResetDecoder();
    audio_->EnableVoiceProcessing(true);
    SetState(ChatState::kListening, "聆听中");
}

void ChatService::EndAudioSession() {
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    if (!audio_)
        return;
    audio_->EnableVoiceProcessing(false);
    if (audio_->IsActive()) {
        audio_->End();
    } else {
        audio_->ResetDecoder();
    }
}

void ChatService::StartConfigTask() {
    if (!started_.load(std::memory_order_relaxed) || config_running_.exchange(true))
        return;
    std::lock_guard<std::mutex> task_lock(config_task_mutex_);
    if (tasks_.config_task) {
        config_running_.store(false, std::memory_order_relaxed);
        ESP_LOGW(kTag, "Config task is still stopping");
        return;
    }
    config_stop_requested_.store(false, std::memory_order_relaxed);
    if (tasks_.config_done_notify) {
        while (xSemaphoreTake(tasks_.config_done_notify, 0) == pdTRUE) {
        }
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ConfigTaskEntry, "xiaozhi_cfg", 8 * 1024, this, 3,
                                            &tasks_.config_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Config task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        config_running_.store(false, std::memory_order_relaxed);
        tasks_.config_task = nullptr;
        if (tasks_.config_done_notify)
            xSemaphoreGive(tasks_.config_done_notify);
        SetError("小智配置任务启动失败");
    }
}

void ChatService::StopConfigTask(bool wait) {
    config_stop_requested_.store(true, std::memory_order_relaxed);
    if (!wait || !config_running_.load(std::memory_order_relaxed))
        return;
    if (!tasks_.config_done_notify)
        return;
    if (xSemaphoreTake(tasks_.config_done_notify, pdMS_TO_TICKS(2000)) != pdTRUE) {
        ESP_LOGW(kTag, "Timed out waiting for config task");
    }
}

void ChatService::SignalConfigTaskStopped() {
    if (tasks_.config_done_notify)
        xSemaphoreGive(tasks_.config_done_notify);
}

void ChatService::ConfigTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ConfigTask();
    bool signal_stopped = false;
    {
        std::lock_guard<std::mutex> task_lock(self->config_task_mutex_);
        if (self->tasks_.config_task == xTaskGetCurrentTaskHandle()) {
            self->tasks_.config_task = nullptr;
            signal_stopped           = true;
        }
    }
    self->config_running_.store(false, std::memory_order_relaxed);
    if (signal_stopped)
        self->SignalConfigTaskStopped();
    vTaskDelete(nullptr);
}

void ChatService::ConfigTask() {
    while (in_mode_.load(std::memory_order_relaxed) && !config_stop_requested_.load(std::memory_order_relaxed) &&
           !settings::HasProtocolConfig()) {
        SetState(ChatState::kCheckingConfig, "获取小智配置中...");
        ActivationClient       client;
        ActivationConfigResult result = client.Fetch();
        if (config_stop_requested_.load(std::memory_order_relaxed) || !in_mode_.load(std::memory_order_relaxed))
            return;
        {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.has_protocol = settings::HasProtocolConfig() || result.has_protocol;
        }

        if (result.has_protocol || settings::HasProtocolConfig()) {
            SetState(ChatState::kReadyIdle, "小智待机");
            return;
        }
        if (result.has_activation_challenge) {
            if (!result.activation_code.empty())
                SetActivation(result.activation_message, result.activation_code);
            esp_err_t activate_err = client.Activate(result.activation_challenge);
            if (activate_err != ESP_OK && activate_err != ESP_ERR_TIMEOUT)
                ESP_LOGW(kTag, "Activation challenge failed: %s", esp_err_to_name(activate_err));
        }
        if (result.has_activation) {
            SetActivation(result.activation_message, result.activation_code);
        } else if (!result.ok) {
            SetError(result.error.empty() ? "小智配置失败" : result.error);
        } else if (result.has_activation_challenge) {
            SetState(ChatState::kCheckingConfig, "小智激活确认中...");
        } else {
            SetError("小智未返回协议配置");
        }

        const int delay_steps = result.has_activation ? 30 : 100;
        for (int i = 0; i < delay_steps && in_mode_.load(std::memory_order_relaxed) &&
                        !config_stop_requested_.load(std::memory_order_relaxed) && !settings::HasProtocolConfig();
             ++i)
            vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (in_mode_.load(std::memory_order_relaxed) && !config_stop_requested_.load(std::memory_order_relaxed) &&
        settings::HasProtocolConfig())
        SetState(ChatState::kReadyIdle, "小智待机");
}

void ChatService::StartControlTask() {
    if (tasks_.control_task || control_running_.exchange(true))
        return;
    if (!tasks_.control_notify)
        tasks_.control_notify = xSemaphoreCreateBinary();
    if (!tasks_.control_notify) {
        ESP_LOGE(kTag, "Control semaphore create failed");
        control_running_.store(false, std::memory_order_relaxed);
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ControlTaskEntry, "xiaozhi_ctl", 4 * 1024, this, 3,
                                            &tasks_.control_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Control task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        tasks_.control_task = nullptr;
        control_running_.store(false, std::memory_order_relaxed);
    }
}

void ChatService::RequestControlClose(uint32_t conversation_token) {
    if (conversation_token != conversation_token_.load(std::memory_order_acquire))
        return;
    ESP_LOGI(kTag, "RequestControlClose token=%lu", static_cast<unsigned long>(conversation_token));
    control_close_token_.store(conversation_token, std::memory_order_release);
    control_close_requested_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void ChatService::RequestConversationStoppedHandling() {
    ESP_LOGI(kTag, "RequestConversationStoppedHandling");
    control_conversation_stopped_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void ChatService::MaybeStartPendingConversation() {
    control_close_requested_.store(false, std::memory_order_relaxed);
    if (!in_mode_.load(std::memory_order_relaxed)) {
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        return;
    }
    if (!settings::HasProtocolConfig()) {
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        if (CurrentState() != ChatState::kError)
            StartConfigTask();
        return;
    }
    if (chat_phase_.load(std::memory_order_relaxed) == ChatPhase::kStartPending) {
        ESP_LOGI(kTag, "MaybeStartPendingConversation starting queued conversation");
        chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
        StartConversationTask();
        return;
    }
    chat_phase_.store(ChatPhase::kIdle, std::memory_order_relaxed);
    if (CurrentState() != ChatState::kError)
        SetState(ChatState::kReadyIdle, "小智待机");
}

void ChatService::ControlTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ControlTask();
    self->tasks_.control_task = nullptr;
    self->control_running_.store(false, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

void ChatService::ControlTask() {
    while (control_running_.load(std::memory_order_relaxed)) {
        if (!tasks_.control_notify) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        xSemaphoreTake(tasks_.control_notify, portMAX_DELAY);
        if (control_close_requested_.exchange(false, std::memory_order_acq_rel)) {
            const uint32_t token = control_close_token_.load(std::memory_order_acquire);
            ESP_LOGI(kTag, "ControlTask close request token=%lu current=%lu", static_cast<unsigned long>(token),
                     static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
            if (token == conversation_token_.load(std::memory_order_acquire))
                StopConversation(false);
        }
        if (control_conversation_stopped_.exchange(false, std::memory_order_acq_rel)) {
            ESP_LOGI(kTag, "ControlTask conversation stopped");
            MaybeStartPendingConversation();
        }
    }
}

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

    if (!audio_->Begin()) {
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
    audio_->EnableVoiceProcessing(true);
    SetState(ChatState::kListening, "聆听中");

    while (ConversationMayRun(chat_phase_.load(std::memory_order_relaxed)) &&
           in_mode_.load(std::memory_order_relaxed)) {
        const bool channel_open = active_protocol->IsAudioChannelOpened();
        if (!channel_open)
            break;

        if (pending_listen_after_playback_.load(std::memory_order_relaxed) && audio_->WaitForPlaybackQueueEmpty(0)) {
            active_protocol->SendStartListening(ListeningMode::kAutoStop);
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            audio_->EnableVoiceProcessing(true);
            SetState(ChatState::kListening, "聆听中");
        }

        bool sent = false;
        while (auto packet = audio_->PopPacketFromSendQueue()) {
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
            audio_->PushPacketToDecodeQueue(std::move(packet));
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
        audio_->EnableVoiceProcessing(false);
        audio_->ResetDecoder();
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
        audio_->EnableVoiceProcessing(false);
        audio_->ResetDecoder();
        SetError(message.empty() ? "小智网络异常" : message);
    });
}

ChatSnapshot ChatService::Snapshot() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_;
}

void ChatService::HandleIncomingJson(const cJSON* root) {
    const IncomingMessage message = ParseIncomingMessage(root);
    switch (message.kind) {
        case IncomingMessageKind::kTtsStart:
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            audio_->EnableVoiceProcessing(false);
            audio_->ResetDecoder();
            SetState(ChatState::kSpeaking, "小智回复中");
            break;
        case IncomingMessageKind::kTtsStop:
            if (ConversationMayRun(chat_phase_.load(std::memory_order_relaxed))) {
                pending_listen_after_playback_.store(true, std::memory_order_relaxed);
            }
            break;
        case IncomingMessageKind::kTtsSentenceStart:
            SetAssistantText(message.text);
            break;
        case IncomingMessageKind::kSttText:
            SetUserText(message.text);
            break;
        case IncomingMessageKind::kLlmEmotion: {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.emotion = message.emotion;
            PostChanged();
            break;
        }
        case IncomingMessageKind::kAlert:
            SetAlert(message.status.empty() ? "小智提醒" : message.status, message.message,
                     message.emotion.empty() ? "neutral" : message.emotion);
            break;
        case IncomingMessageKind::kAlertMissingMessage:
            ESP_LOGW(kTag, "Ignore alert without message");
            break;
        case IncomingMessageKind::kNone:
            break;
    }
}

void ChatService::SetState(ChatState state, const std::string& status) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state        = state;
        snapshot_.has_protocol = settings::HasProtocolConfig();
        if (!status.empty())
            snapshot_.status = status;
        if (state == ChatState::kReadyIdle)
            snapshot_.emotion = "neutral";
        if (state == ChatState::kReadyIdle) {
            snapshot_.messages.clear();
            snapshot_.user_text.clear();
            snapshot_.assistant_text.clear();
        }
        if (state != ChatState::kAwaitingActivation) {
            snapshot_.activation_message.clear();
            snapshot_.activation_code.clear();
        }
        if (state != ChatState::kError)
            snapshot_.error.clear();
    }
    PostChanged();
}

void ChatService::SetError(const std::string& error) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state        = ChatState::kError;
        snapshot_.status       = "小智异常";
        snapshot_.emotion      = "sad";
        snapshot_.error        = error;
        snapshot_.has_protocol = settings::HasProtocolConfig();
        ClearAlertLocked();
    }
    PostChanged();
}

void ChatService::SetActivation(const std::string& message, const std::string& code) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state              = ChatState::kAwaitingActivation;
        snapshot_.status             = "小智激活";
        snapshot_.emotion            = "thinking";
        snapshot_.activation_message = message;
        snapshot_.activation_code    = code;
        snapshot_.has_protocol       = false;
        snapshot_.error.clear();
        ClearAlertLocked();
    }
    PostChanged();
}

void ChatService::SetUserText(const std::string& text) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.user_text = text;
        if (!text.empty())
            snapshot_.messages.push_back({"user", text});
        TrimMessagesLocked();
    }
    PostChanged();
}

void ChatService::SetAssistantText(const std::string& text) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.assistant_text = text;
        if (!text.empty())
            snapshot_.messages.push_back({"assistant", text});
        TrimMessagesLocked();
    }
    PostChanged();
}

void ChatService::SetAlert(const std::string& status, const std::string& message, const std::string& emotion) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.status        = status;
        snapshot_.emotion       = emotion;
        snapshot_.alert_active  = true;
        snapshot_.alert_status  = status;
        snapshot_.alert_message = message;
        snapshot_.alert_emotion = emotion;
        snapshot_.error.clear();
    }
    PostChanged();
}

void ChatService::ClearAlertLocked() {
    snapshot_.alert_active = false;
    snapshot_.alert_status.clear();
    snapshot_.alert_message.clear();
    snapshot_.alert_emotion.clear();
}

void ChatService::TrimMessagesLocked() {
    if (snapshot_.messages.size() > 12)
        snapshot_.messages.erase(snapshot_.messages.begin(),
                                 snapshot_.messages.begin() + (snapshot_.messages.size() - 12));
}

ChatState ChatService::CurrentState() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_.state;
}

void ChatService::PostChanged() {
    evt::PostSimple(UiEventKind::kXiaozhiChanged, pdMS_TO_TICKS(50));
}

}  // namespace xiaozhi
