#include "xiaozhi_chat_service.h"

#include <cJSON.h>
#include <esp_heap_caps.h>
#include <esp_log.h>

#include <algorithm>
#include <cstring>

#include "audio_player.h"
#include "event_bus.h"
#include "volume_store.h"
#include "xiaozhi_audio_service.h"
#include "xiaozhi_config_client.h"
#include "xiaozhi_settings.h"

namespace {
constexpr char kTag[] = "XiaoChat";
constexpr int kNoSendDiagIntervalMs = 1000;

std::string JsonString(const cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}
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
    if (!config_done_notify_) {
        config_done_notify_ = xSemaphoreCreateBinary();
        if (!config_done_notify_) {
            ESP_LOGE(kTag, "Config done semaphore create failed");
            return false;
        }
    }
    if (!AudioService::Get().Start(player_))
        return false;
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
        snapshot_.alert_active = false;
        snapshot_.alert_status.clear();
        snapshot_.alert_message.clear();
        snapshot_.alert_emotion.clear();
    }
    if (settings::HasProtocolConfig()) {
        SetState(ChatState::kReadyIdle, "小智待机");
    } else {
        StartConfigTask();
    }
}

void ChatService::LeaveMode() {
    in_mode_.store(false, std::memory_order_relaxed);
    StopConfigTask(true);
    StopConversation(true);
}

void ChatService::ToggleChat() {
    const ChatState state = CurrentState();
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
        case ChatState::kCheckingConfig:
        case ChatState::kAwaitingActivation:
            break;
    }
}

void ChatService::StopConversation(bool send_goodbye) {
    conversation_running_.store(false, std::memory_order_relaxed);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    std::shared_ptr<Protocol> protocol;
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol = protocol_;
        protocol_.reset();
    }
    if (protocol)
        protocol->CloseAudioChannel(send_goodbye);
    EndAudioSession();
    if (in_mode_.load(std::memory_order_relaxed) && CurrentState() != ChatState::kError) {
        if (settings::HasProtocolConfig())
            SetState(ChatState::kReadyIdle, "小智待机");
        else
            StartConfigTask();
    }
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
    return in_mode_.load(std::memory_order_relaxed) ||
           config_running_.load(std::memory_order_relaxed) ||
           conversation_running_.load(std::memory_order_relaxed) ||
           AudioService::Get().IsActive();
}

void ChatService::SuspendForSleep() {
    in_mode_.store(false, std::memory_order_relaxed);
    StopConfigTask(true);
    control_close_requested_.store(false, std::memory_order_relaxed);
    conversation_running_.store(false, std::memory_order_relaxed);
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
    EndAudioSession();
}

void ChatService::NotifyNetworkClosed(uint32_t conversation_token) {
    RequestControlClose(conversation_token);
}

ChatSnapshot ChatService::Snapshot() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_;
}

void ChatService::StartConfigTask() {
    if (!started_.load(std::memory_order_relaxed) || config_running_.exchange(true))
        return;
    config_stop_requested_.store(false, std::memory_order_relaxed);
    if (config_done_notify_) {
        while (xSemaphoreTake(config_done_notify_, 0) == pdTRUE) {
        }
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ConfigTaskEntry, "xiaozhi_cfg", 8 * 1024, this, 3,
                                            &config_task_, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Config task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        config_running_.store(false, std::memory_order_relaxed);
        config_task_ = nullptr;
        SetError("小智配置任务启动失败");
    }
}

void ChatService::StartConversationTask() {
    if (!started_.load(std::memory_order_relaxed) || conversation_running_.exchange(true))
        return;
    conversation_token_.fetch_add(1, std::memory_order_relaxed);
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ConversationTaskEntry, "xiaozhi_conv", 10 * 1024, this, 4,
                                            &conversation_task_, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Conversation task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        conversation_running_.store(false, std::memory_order_relaxed);
        conversation_task_ = nullptr;
        SetError("小智对话任务启动失败");
    }
}

void ChatService::StartControlTask() {
    if (control_task_ || control_running_.exchange(true))
        return;
    if (!control_notify_)
        control_notify_ = xSemaphoreCreateBinary();
    if (!control_notify_) {
        ESP_LOGE(kTag, "Control semaphore create failed");
        control_running_.store(false, std::memory_order_relaxed);
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&ChatService::ControlTaskEntry, "xiaozhi_ctl", 4 * 1024, this, 3,
                                            &control_task_, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Control task create failed: internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        control_task_ = nullptr;
        control_running_.store(false, std::memory_order_relaxed);
    }
}

void ChatService::RequestControlClose(uint32_t conversation_token) {
    if (conversation_token != conversation_token_.load(std::memory_order_relaxed))
        return;
    control_close_token_.store(conversation_token, std::memory_order_relaxed);
    control_close_requested_.store(true, std::memory_order_relaxed);
    if (control_notify_)
        xSemaphoreGive(control_notify_);
}

void ChatService::StopConfigTask(bool wait) {
    config_stop_requested_.store(true, std::memory_order_relaxed);
    if (!wait || !config_running_.load(std::memory_order_relaxed))
        return;
    if (!config_done_notify_)
        return;
    if (xSemaphoreTake(config_done_notify_, pdMS_TO_TICKS(2000)) != pdTRUE) {
        ESP_LOGW(kTag, "Timed out waiting for config task");
    }
}

void ChatService::SignalConfigTaskStopped() {
    if (config_done_notify_)
        xSemaphoreGive(config_done_notify_);
}

void ChatService::ConfigTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ConfigTask();
    self->config_task_ = nullptr;
    self->config_running_.store(false, std::memory_order_relaxed);
    self->SignalConfigTaskStopped();
    vTaskDelete(nullptr);
}

void ChatService::ConversationTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ConversationTask();
    self->conversation_task_ = nullptr;
    self->conversation_running_.store(false, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

void ChatService::ControlTaskEntry(void* arg) {
    auto* self = static_cast<ChatService*>(arg);
    self->ControlTask();
    self->control_task_ = nullptr;
    self->control_running_.store(false, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

void ChatService::ControlTask() {
    while (control_running_.load(std::memory_order_relaxed)) {
        if (!control_notify_) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        xSemaphoreTake(control_notify_, portMAX_DELAY);
        if (control_close_requested_.exchange(false, std::memory_order_relaxed)) {
            const uint32_t token = control_close_token_.load(std::memory_order_relaxed);
            if (token == conversation_token_.load(std::memory_order_relaxed))
                StopConversation(false);
        }
    }
}

void ChatService::ConfigTask() {
    while (in_mode_.load(std::memory_order_relaxed) &&
           !config_stop_requested_.load(std::memory_order_relaxed) &&
           !settings::HasProtocolConfig()) {
        SetState(ChatState::kCheckingConfig, "获取小智配置中...");
        ConfigClient client;
        ConfigResult result = client.Fetch();
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
            ESP_LOGI(kTag, "Activation challenge result: %s", esp_err_to_name(activate_err));
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
        for (int i = 0; i < delay_steps &&
                        in_mode_.load(std::memory_order_relaxed) &&
                        !config_stop_requested_.load(std::memory_order_relaxed) &&
                        !settings::HasProtocolConfig(); ++i)
            vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (in_mode_.load(std::memory_order_relaxed) &&
        !config_stop_requested_.load(std::memory_order_relaxed) &&
        settings::HasProtocolConfig())
        SetState(ChatState::kReadyIdle, "小智待机");
}

void ChatService::ConversationTask() {
    const uint32_t token = conversation_token_.load(std::memory_order_relaxed);
    if (!settings::HasProtocolConfig()) {
        StartConfigTask();
        return;
    }

    SetState(ChatState::kConnecting, "连接小智中...");
    auto protocol = CreatePreferredProtocol();
    if (!protocol) {
        SetError("未获取小智协议配置");
        return;
    }
    ConfigureProtocolCallbacks(protocol.get());
    protocol->SetOwnerToken(token);
    protocol->PrepareAudioChannelOpen();
    std::shared_ptr<Protocol> active_protocol = std::move(protocol);
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        protocol_ = active_protocol;
    }

    bool opened = false;
    if (conversation_running_.load(std::memory_order_relaxed) &&
        in_mode_.load(std::memory_order_relaxed) &&
        active_protocol->Start()) {
        opened = active_protocol->OpenAudioChannel();
    }
    if (!opened || !conversation_running_.load(std::memory_order_relaxed) || !in_mode_.load(std::memory_order_relaxed)) {
        const bool cancelled = !conversation_running_.load(std::memory_order_relaxed) ||
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

    active_protocol->SendStartListening(ListeningMode::kAutoStop);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    AudioService::Get().EnableVoiceProcessing(true);
    SetState(ChatState::kListening, "聆听中");
    AudioService::Get().DumpDiagnostics("listen-start");
    int no_send_elapsed_ms = 0;

    while (conversation_running_.load(std::memory_order_relaxed) && in_mode_.load(std::memory_order_relaxed)) {
        bool channel_open = false;
        channel_open = active_protocol->IsAudioChannelOpened();
        if (!channel_open)
            break;

        if (pending_listen_after_playback_.load(std::memory_order_relaxed) &&
            AudioService::Get().WaitForPlaybackQueueEmpty(0)) {
            active_protocol->SendStartListening(ListeningMode::kAutoStop);
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            AudioService::Get().EnableVoiceProcessing(true);
            SetState(ChatState::kListening, "聆听中");
            AudioService::Get().DumpDiagnostics("listen-resume");
            no_send_elapsed_ms = 0;
        }

        bool sent = false;
        while (auto packet = AudioService::Get().PopPacketFromSendQueue()) {
            if (!active_protocol->SendAudio(std::move(packet)))
                break;
            sent = true;
        }
        if (!sent) {
            vTaskDelay(pdMS_TO_TICKS(10));
            if (CurrentState() == ChatState::kListening &&
                AudioService::Get().IsVoiceProcessing()) {
                no_send_elapsed_ms += 10;
                if (no_send_elapsed_ms >= kNoSendDiagIntervalMs) {
                    AudioService::Get().DumpDiagnostics("listening-no-send");
                    no_send_elapsed_ms = 0;
                }
            } else {
                no_send_elapsed_ms = 0;
            }
        } else {
            no_send_elapsed_ms = 0;
        }
    }

    conversation_running_.store(false, std::memory_order_relaxed);
    EndAudioSession();
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    active_protocol->CloseAudioChannel(false);
    {
        std::lock_guard<std::mutex> lock(protocol_mutex_);
        if (protocol_ == active_protocol)
            protocol_.reset();
    }
    if (in_mode_.load(std::memory_order_relaxed) && CurrentState() != ChatState::kError)
        SetState(ChatState::kReadyIdle, "小智待机");
}

void ChatService::ConfigureProtocolCallbacks(Protocol* protocol) {
    protocol->OnIncomingAudio([this](std::unique_ptr<AudioStreamPacket> packet) {
        if (CurrentState() == ChatState::kSpeaking)
            AudioService::Get().PushPacketToDecodeQueue(std::move(packet));
    });
    protocol->OnIncomingJson([this](const cJSON* root) { HandleIncomingJson(root); });
    protocol->OnAudioChannelClosed([this]() {
        conversation_running_.store(false, std::memory_order_relaxed);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        AudioService::Get().EnableVoiceProcessing(false);
        AudioService::Get().ResetDecoder();
        if (in_mode_.load(std::memory_order_relaxed) && CurrentState() != ChatState::kError)
            SetState(ChatState::kReadyIdle, "小智待机");
    });
    protocol->OnNetworkError([this](const std::string& message) {
        conversation_running_.store(false, std::memory_order_relaxed);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        AudioService::Get().EnableVoiceProcessing(false);
        AudioService::Get().ResetDecoder();
        SetError(message.empty() ? "小智网络异常" : message);
    });
}

void ChatService::HandleIncomingJson(const cJSON* root) {
    cJSON* type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type) || !type->valuestring)
        return;

    if (std::strcmp(type->valuestring, "tts") == 0) {
        const std::string state = JsonString(root, "state");
        if (state == "start") {
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            AudioService::Get().EnableVoiceProcessing(false);
            AudioService::Get().ResetDecoder();
            SetState(ChatState::kSpeaking, "小智回复中");
        } else if (state == "stop") {
            if (conversation_running_.load(std::memory_order_relaxed)) {
                pending_listen_after_playback_.store(true, std::memory_order_relaxed);
            }
        } else if (state == "sentence_start") {
            const std::string text = JsonString(root, "text");
            if (!text.empty())
                SetAssistantText(text);
        }
    } else if (std::strcmp(type->valuestring, "stt") == 0) {
        const std::string text = JsonString(root, "text");
        if (!text.empty())
            SetUserText(text);
    } else if (std::strcmp(type->valuestring, "llm") == 0) {
        const std::string emotion = JsonString(root, "emotion");
        if (!emotion.empty()) {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.emotion = emotion;
            PostChanged();
        }
    } else if (std::strcmp(type->valuestring, "alert") == 0) {
        const std::string status = JsonString(root, "status");
        const std::string message = JsonString(root, "message");
        const std::string emotion = JsonString(root, "emotion");
        if (message.empty()) {
            ESP_LOGW(kTag, "Ignore alert without message");
        } else {
            SetAlert(status.empty() ? "小智提醒" : status,
                     message,
                     emotion.empty() ? "neutral" : emotion);
        }
    } else if (std::strcmp(type->valuestring, "system") == 0) {
        ESP_LOGI(kTag, "Ignore system command: %s", JsonString(root, "command").c_str());
    } else if (std::strcmp(type->valuestring, "mcp") == 0) {
        ESP_LOGD(kTag, "Ignore MCP message");
    }
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
        AudioService::Get().End(vol::ToCodec(vol::GetAlbum()));
    } else {
        AudioService::Get().ResetDecoder();
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
        snapshot_.alert_active = false;
        snapshot_.alert_status.clear();
        snapshot_.alert_message.clear();
        snapshot_.alert_emotion.clear();
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
        snapshot_.alert_active = false;
        snapshot_.alert_status.clear();
        snapshot_.alert_message.clear();
        snapshot_.alert_emotion.clear();
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
        snapshot_.alert_active = false;
        snapshot_.alert_status.clear();
        snapshot_.alert_message.clear();
        snapshot_.alert_emotion.clear();
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
    ESP_LOGW(kTag, "Alert [%s] %s: %s", emotion.c_str(), status.c_str(), message.c_str());
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.status = status;
        snapshot_.emotion = emotion;
        snapshot_.alert_active = true;
        snapshot_.alert_status = status;
        snapshot_.alert_message = message;
        snapshot_.alert_emotion = emotion;
        snapshot_.error.clear();
    }
    PostChanged();
}

void ChatService::TrimMessagesLocked() {
    if (snapshot_.messages.size() > 12)
        snapshot_.messages.erase(snapshot_.messages.begin(), snapshot_.messages.begin() + (snapshot_.messages.size() - 12));
}

ChatState ChatService::CurrentState() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_.state;
}

void ChatService::PostChanged() {
    UiEvent e{};
    e.kind = UiEventKind::kXiaozhiChanged;
    evt::Post(e, pdMS_TO_TICKS(50));
}

}  // namespace xiaozhi
