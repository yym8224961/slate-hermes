#include "xiaozhi/service/xiaozhi_service.h"

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
#include "xiaozhi/service/message_handler.h"
#include "xiaozhi/service/xiaozhi_phase.h"

namespace {
constexpr char kTag[] = "xiaozhi_service";

const char* XiaozhiStateName(xiaozhi::XiaozhiState state) {
    switch (state) {
        case xiaozhi::XiaozhiState::kCheckingConfig:
            return "checking_config";
        case xiaozhi::XiaozhiState::kAwaitingActivation:
            return "awaiting_activation";
        case xiaozhi::XiaozhiState::kReadyIdle:
            return "ready_idle";
        case xiaozhi::XiaozhiState::kConnecting:
            return "connecting";
        case xiaozhi::XiaozhiState::kListening:
            return "listening";
        case xiaozhi::XiaozhiState::kSpeaking:
            return "speaking";
        case xiaozhi::XiaozhiState::kStopping:
            return "stopping";
        case xiaozhi::XiaozhiState::kError:
            return "error";
    }
    return "unknown";
}

const char* XiaozhiPhaseName(xiaozhi::XiaozhiPhase phase) {
    switch (phase) {
        case xiaozhi::XiaozhiPhase::kIdle:
            return "idle";
        case xiaozhi::XiaozhiPhase::kStarting:
            return "starting";
        case xiaozhi::XiaozhiPhase::kRunning:
            return "running";
        case xiaozhi::XiaozhiPhase::kStopping:
            return "stopping";
        case xiaozhi::XiaozhiPhase::kStartPending:
            return "start_pending";
    }
    return "unknown";
}
}  // namespace

namespace xiaozhi {

XiaozhiService& XiaozhiService::Get() {
    static XiaozhiService s;
    return s;
}

bool XiaozhiService::Start(AudioPlayer* player, AudioService* audio) {
    if (!player || !audio)
        return false;
    player_ = player;
    audio_  = audio;
    if (!tasks_.config_done_notify) {
        tasks_.config_done_notify = xSemaphoreCreateBinary();
        if (!tasks_.config_done_notify) {
            ESP_LOGE(kTag, "config done semaphore create failed");
            return false;
        }
    }
    if (!audio_->Start(player_))
        return false;
    if (!tasks_.conversation_done_notify) {
        tasks_.conversation_done_notify = xSemaphoreCreateBinary();
        if (!tasks_.conversation_done_notify) {
            ESP_LOGE(kTag, "conversation done semaphore create failed");
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

void XiaozhiService::EnterMode() {
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
    const XiaozhiPhase phase = xiaozhi_phase_.load(std::memory_order_relaxed);
    if (has_conversation_task || ConversationBlocksSleep(phase)) {
        SetState(XiaozhiState::kStopping, "小智正在收尾...");
    } else if (settings::HasProtocolConfig()) {
        SetState(XiaozhiState::kReadyIdle, "小智待机");
    } else {
        StartConfigTask();
    }
}

void XiaozhiService::LeaveMode() {
    in_mode_.store(false, std::memory_order_relaxed);
    if (xiaozhi_phase_.load(std::memory_order_relaxed) == XiaozhiPhase::kStartPending)
        xiaozhi_phase_.store(XiaozhiPhase::kStopping, std::memory_order_relaxed);
    StopConfigTask(true);
    StopConversation(true);
    const bool stopped = WaitForConversationStopped(3000);
    if (stopped)
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
    ESP_LOGD(kTag, "leave mode stopped=%d", stopped ? 1 : 0);
}

void XiaozhiService::ToggleXiaozhi() {
    const XiaozhiState state = CurrentState();
    ESP_LOGI(kTag, "toggle xiaozhi state=%s", XiaozhiStateName(state));
    switch (state) {
        case XiaozhiState::kReadyIdle:
        case XiaozhiState::kError:
            if (settings::HasProtocolConfig()) {
                StartConversationTask();
            } else {
                StartConfigTask();
            }
            break;
        case XiaozhiState::kListening:
        case XiaozhiState::kConnecting:
            StopConversation(true);
            break;
        case XiaozhiState::kSpeaking:
            InterruptSpeaking();
            break;
        case XiaozhiState::kStopping:
            if (settings::HasProtocolConfig()) {
                xiaozhi_phase_.store(XiaozhiPhase::kStartPending, std::memory_order_relaxed);
                SetState(XiaozhiState::kStopping, "小智正在收尾...");
            }
            break;
        case XiaozhiState::kCheckingConfig:
        case XiaozhiState::kAwaitingActivation:
            break;
    }
}

void XiaozhiService::StopConversation(bool send_goodbye) {
    ESP_LOGD(kTag, "stop conversation begin goodbye=%d", send_goodbye ? 1 : 0);
    const bool was_running = SetStoppingIfMayRun(xiaozhi_phase_);
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
        const XiaozhiPhase phase = xiaozhi_phase_.load(std::memory_order_relaxed);
        if (phase == XiaozhiPhase::kIdle)
            xiaozhi_phase_.store(XiaozhiPhase::kStopping, std::memory_order_relaxed);
        if (CurrentState() != XiaozhiState::kError)
            SetState(XiaozhiState::kStopping, "小智正在收尾...");
    }
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    if (protocol)
        protocol->CloseAudioChannel(send_goodbye);
    EndAudioSession();
    ESP_LOGD(kTag, "stop conversation done was_running=%d has_task=%d had_protocol=%d", was_running ? 1 : 0,
             has_task ? 1 : 0, protocol ? 1 : 0);
}

void XiaozhiService::AdjustVolume(int delta) {
    const int level = std::clamp(settings::GetVolume() + delta, 0, vol::kMax);
    SetVolume(level);
}

void XiaozhiService::PreviewVolume(int level) {
    level = std::clamp(level, 0, vol::kMax);
    if (player_)
        player_->SetVolume(vol::ToCodec(level));
}

void XiaozhiService::SetVolume(int level) {
    level = std::clamp(level, 0, vol::kMax);
    settings::SetVolume(level);
    PreviewVolume(level);
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = level;
    }
    PostChanged();
}

bool XiaozhiService::BlocksSleep() const {
    const bool audio_active = audio_ && audio_->IsActive();
    return in_mode_.load(std::memory_order_relaxed) || config_running_.load(std::memory_order_relaxed) ||
           ConversationBlocksSleep(xiaozhi_phase_.load(std::memory_order_relaxed)) || audio_active;
}

void XiaozhiService::SuspendForSleep() {
    in_mode_.store(false, std::memory_order_relaxed);
    xiaozhi_phase_.store(XiaozhiPhase::kStopping, std::memory_order_relaxed);
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
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
}

void XiaozhiService::NotifyNetworkClosed(uint32_t conversation_token) {
    RequestControlClose(conversation_token);
}

void XiaozhiService::StartConversationTask() {
    if (!started_.load(std::memory_order_relaxed))
        return;
    std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
    const XiaozhiPhase          phase = xiaozhi_phase_.load(std::memory_order_relaxed);
    if (tasks_.conversation_task || ConversationStopOrRestartPending(phase)) {
        ESP_LOGD(kTag, "conversation queued task=%p phase=%s", tasks_.conversation_task, XiaozhiPhaseName(phase));
        QueueConversationStartLocked();
        return;
    }
    XiaozhiPhase expected = XiaozhiPhase::kIdle;
    if (!xiaozhi_phase_.compare_exchange_strong(expected, XiaozhiPhase::kStarting, std::memory_order_relaxed))
        return;
    if (tasks_.conversation_done_notify) {
        while (xSemaphoreTake(tasks_.conversation_done_notify, 0) == pdTRUE) {
        }
    }
    conversation_token_.fetch_add(1, std::memory_order_acq_rel);
    ESP_LOGD(kTag, "conversation start token=%lu",
             static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
    BaseType_t ok = xTaskCreatePinnedToCore(&XiaozhiService::ConversationTaskEntry, "xiaozhi_conv", 10 * 1024, this, 4,
                                            &tasks_.conversation_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "conversation task create failed internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
        tasks_.conversation_task = nullptr;
        if (tasks_.conversation_done_notify)
            xSemaphoreGive(tasks_.conversation_done_notify);
        SetError("小智对话任务启动失败");
    } else {
        ESP_LOGD(kTag, "conversation task created task=%p", tasks_.conversation_task);
    }
}

bool XiaozhiService::HasConversationTaskLocked() const {
    return tasks_.conversation_task != nullptr;
}

void XiaozhiService::QueueConversationStartLocked() {
    ESP_LOGD(kTag, "queue conversation start");
    xiaozhi_phase_.store(XiaozhiPhase::kStartPending, std::memory_order_relaxed);
    if (in_mode_.load(std::memory_order_relaxed) && CurrentState() != XiaozhiState::kError)
        SetState(XiaozhiState::kStopping, "小智正在收尾...");
}

bool XiaozhiService::WaitForConversationStopped(int timeout_ms) {
    ESP_LOGD(kTag, "wait conversation stopped begin timeout_ms=%d", timeout_ms);
    {
        std::lock_guard<std::mutex> task_lock(conversation_task_mutex_);
        const XiaozhiPhase          phase = xiaozhi_phase_.load(std::memory_order_relaxed);
        if (!ConversationMayRun(phase) && !tasks_.conversation_task) {
            ESP_LOGD(kTag, "wait conversation stopped skip reason=already_stopped");
            return true;
        }
    }
    if (!tasks_.conversation_done_notify)
        return false;
    if (xSemaphoreTake(tasks_.conversation_done_notify, pdMS_TO_TICKS(timeout_ms)) == pdTRUE) {
        ESP_LOGD(kTag, "wait conversation stopped done");
        return true;
    }
    ESP_LOGW(kTag, "wait conversation stopped timeout timeout_ms=%d", timeout_ms);
    return false;
}

void XiaozhiService::InterruptSpeaking() {
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
    SetState(XiaozhiState::kListening, "聆听中");
}

void XiaozhiService::EndAudioSession() {
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

void XiaozhiService::StartConfigTask() {
    if (!started_.load(std::memory_order_relaxed) || config_running_.exchange(true))
        return;
    std::lock_guard<std::mutex> task_lock(config_task_mutex_);
    if (tasks_.config_task) {
        config_running_.store(false, std::memory_order_relaxed);
        ESP_LOGW(kTag, "config task start skipped reason=still_stopping");
        return;
    }
    config_stop_requested_.store(false, std::memory_order_relaxed);
    if (tasks_.config_done_notify) {
        while (xSemaphoreTake(tasks_.config_done_notify, 0) == pdTRUE) {
        }
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&XiaozhiService::ConfigTaskEntry, "xiaozhi_cfg", 8 * 1024, this, 3,
                                            &tasks_.config_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "config task create failed internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        config_running_.store(false, std::memory_order_relaxed);
        tasks_.config_task = nullptr;
        if (tasks_.config_done_notify)
            xSemaphoreGive(tasks_.config_done_notify);
        SetError("小智配置任务启动失败");
    }
}

void XiaozhiService::StopConfigTask(bool wait) {
    config_stop_requested_.store(true, std::memory_order_relaxed);
    if (!wait || !config_running_.load(std::memory_order_relaxed))
        return;
    if (!tasks_.config_done_notify)
        return;
    if (xSemaphoreTake(tasks_.config_done_notify, pdMS_TO_TICKS(2000)) != pdTRUE) {
        ESP_LOGW(kTag, "config task stop timeout");
    }
}

void XiaozhiService::SignalConfigTaskStopped() {
    if (tasks_.config_done_notify)
        xSemaphoreGive(tasks_.config_done_notify);
}

void XiaozhiService::ConfigTaskEntry(void* arg) {
    auto* self = static_cast<XiaozhiService*>(arg);
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

void XiaozhiService::ConfigTask() {
    while (in_mode_.load(std::memory_order_relaxed) && !config_stop_requested_.load(std::memory_order_relaxed) &&
           !settings::HasProtocolConfig()) {
        SetState(XiaozhiState::kCheckingConfig, "获取小智配置中...");
        ActivationClient       client;
        ActivationConfigResult result = client.Fetch();
        if (config_stop_requested_.load(std::memory_order_relaxed) || !in_mode_.load(std::memory_order_relaxed))
            return;
        {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.has_protocol = settings::HasProtocolConfig() || result.has_protocol;
        }

        if (result.has_protocol || settings::HasProtocolConfig()) {
            SetState(XiaozhiState::kReadyIdle, "小智待机");
            return;
        }
        if (result.has_activation_challenge) {
            if (!result.activation_code.empty())
                SetActivation(result.activation_message, result.activation_code);
            esp_err_t activate_err = client.Activate(result.activation_challenge);
            if (activate_err != ESP_OK && activate_err != ESP_ERR_TIMEOUT)
                ESP_LOGW(kTag, "activation challenge failed err=%s", esp_err_to_name(activate_err));
        }
        if (result.has_activation) {
            SetActivation(result.activation_message, result.activation_code);
        } else if (!result.ok) {
            SetError(result.error.empty() ? "小智配置失败" : result.error);
        } else if (result.has_activation_challenge) {
            SetState(XiaozhiState::kCheckingConfig, "小智激活确认中...");
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
        SetState(XiaozhiState::kReadyIdle, "小智待机");
}

void XiaozhiService::StartControlTask() {
    if (tasks_.control_task || control_running_.exchange(true))
        return;
    if (!tasks_.control_notify)
        tasks_.control_notify = xSemaphoreCreateBinary();
    if (!tasks_.control_notify) {
        ESP_LOGE(kTag, "control semaphore create failed");
        control_running_.store(false, std::memory_order_relaxed);
        return;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(&XiaozhiService::ControlTaskEntry, "xiaozhi_ctl", 4 * 1024, this, 3,
                                            &tasks_.control_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "control task create failed internal_free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        tasks_.control_task = nullptr;
        control_running_.store(false, std::memory_order_relaxed);
    }
}

void XiaozhiService::RequestControlClose(uint32_t conversation_token) {
    if (conversation_token != conversation_token_.load(std::memory_order_acquire))
        return;
    ESP_LOGD(kTag, "control close request token=%lu", static_cast<unsigned long>(conversation_token));
    control_close_token_.store(conversation_token, std::memory_order_release);
    control_close_requested_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void XiaozhiService::RequestConversationStoppedHandling() {
    ESP_LOGD(kTag, "conversation stopped request");
    control_conversation_stopped_.store(true, std::memory_order_release);
    if (tasks_.control_notify)
        xSemaphoreGive(tasks_.control_notify);
}

void XiaozhiService::MaybeStartPendingConversation() {
    control_close_requested_.store(false, std::memory_order_relaxed);
    if (!in_mode_.load(std::memory_order_relaxed)) {
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
        return;
    }
    if (!settings::HasProtocolConfig()) {
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
        if (CurrentState() != XiaozhiState::kError)
            StartConfigTask();
        return;
    }
    if (xiaozhi_phase_.load(std::memory_order_relaxed) == XiaozhiPhase::kStartPending) {
        ESP_LOGD(kTag, "conversation queued start");
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
        StartConversationTask();
        return;
    }
    xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
    if (CurrentState() != XiaozhiState::kError)
        SetState(XiaozhiState::kReadyIdle, "小智待机");
}

void XiaozhiService::ControlTaskEntry(void* arg) {
    auto* self = static_cast<XiaozhiService*>(arg);
    self->ControlTask();
    self->tasks_.control_task = nullptr;
    self->control_running_.store(false, std::memory_order_relaxed);
    vTaskDelete(nullptr);
}

void XiaozhiService::ControlTask() {
    while (control_running_.load(std::memory_order_relaxed)) {
        if (!tasks_.control_notify) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        xSemaphoreTake(tasks_.control_notify, portMAX_DELAY);
        if (control_close_requested_.exchange(false, std::memory_order_acq_rel)) {
            const uint32_t token = control_close_token_.load(std::memory_order_acquire);
            ESP_LOGD(kTag, "control close token=%lu current=%lu", static_cast<unsigned long>(token),
                     static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
            if (token == conversation_token_.load(std::memory_order_acquire))
                StopConversation(false);
        }
        if (control_conversation_stopped_.exchange(false, std::memory_order_acq_rel)) {
            ESP_LOGD(kTag, "control conversation stopped");
            MaybeStartPendingConversation();
        }
    }
}

void XiaozhiService::ConversationTaskEntry(void* arg) {
    auto* self = static_cast<XiaozhiService*>(arg);
    self->ConversationTask();
    bool signal_stopped = false;
    {
        std::lock_guard<std::mutex> task_lock(self->conversation_task_mutex_);
        if (self->tasks_.conversation_task == xTaskGetCurrentTaskHandle()) {
            self->tasks_.conversation_task = nullptr;
            signal_stopped                 = true;
        }
    }
    SetStoppingIfMayRun(self->xiaozhi_phase_);
    if (signal_stopped && self->tasks_.conversation_done_notify)
        xSemaphoreGive(self->tasks_.conversation_done_notify);
    if (signal_stopped)
        self->RequestConversationStoppedHandling();
    ESP_LOGD(kTag, "conversation task exit signal_stopped=%d", signal_stopped ? 1 : 0);
    vTaskDelete(nullptr);
}

void XiaozhiService::ConversationTask() {
    const uint32_t token = conversation_token_.load(std::memory_order_acquire);
    ESP_LOGD(kTag, "conversation begin token=%lu", static_cast<unsigned long>(token));
    if (!ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed)))
        return;
    if (!settings::HasProtocolConfig()) {
        xiaozhi_phase_.store(XiaozhiPhase::kIdle, std::memory_order_relaxed);
        StartConfigTask();
        return;
    }

    SetState(XiaozhiState::kConnecting, "连接小智中...");
    auto protocol = CreatePreferredProtocol();
    if (!protocol) {
        SetStoppingIfMayRun(xiaozhi_phase_);
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
    if (ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed)) &&
        in_mode_.load(std::memory_order_relaxed) && active_protocol->Start()) {
        opened = active_protocol->OpenAudioChannel();
    }
    ESP_LOGD(kTag, "conversation open opened=%d phase=%s in_mode=%d", opened ? 1 : 0,
             XiaozhiPhaseName(xiaozhi_phase_.load(std::memory_order_relaxed)),
             in_mode_.load(std::memory_order_relaxed) ? 1 : 0);
    if (!opened || !ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed)) ||
        !in_mode_.load(std::memory_order_relaxed)) {
        const bool cancelled = !ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed)) ||
                               !in_mode_.load(std::memory_order_relaxed);
        if (!opened && !cancelled && CurrentState() != XiaozhiState::kError)
            SetError("小智连接失败");
        StopConversation(false);
        return;
    }

    if (!audio_->Begin()) {
        SetError("音频初始化失败");
        StopConversation(true);
        return;
    }

    if (!ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed))) {
        StopConversation(false);
        return;
    }
    xiaozhi_phase_.store(XiaozhiPhase::kRunning, std::memory_order_relaxed);
    active_protocol->SendStartListening(ListeningMode::kAutoStop);
    pending_listen_after_playback_.store(false, std::memory_order_relaxed);
    audio_->EnableVoiceProcessing(true);
    SetState(XiaozhiState::kListening, "聆听中");

    while (ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed)) &&
           in_mode_.load(std::memory_order_relaxed)) {
        const bool channel_open = active_protocol->IsAudioChannelOpened();
        if (!channel_open)
            break;

        if (pending_listen_after_playback_.load(std::memory_order_relaxed) && audio_->WaitForPlaybackQueueEmpty(0)) {
            active_protocol->SendStartListening(ListeningMode::kAutoStop);
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            audio_->EnableVoiceProcessing(true);
            SetState(XiaozhiState::kListening, "聆听中");
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

    ESP_LOGD(kTag, "conversation loop exit phase=%s in_mode=%d channel_open=%d",
             XiaozhiPhaseName(xiaozhi_phase_.load(std::memory_order_relaxed)),
             in_mode_.load(std::memory_order_relaxed) ? 1 : 0, active_protocol->IsAudioChannelOpened() ? 1 : 0);
    SetStoppingIfMayRun(xiaozhi_phase_);
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
    if (CurrentState() != XiaozhiState::kError)
        SetState(XiaozhiState::kStopping, "小智正在收尾...");
}

void XiaozhiService::ConfigureProtocolCallbacks(Protocol* protocol) {
    const uint32_t token = protocol->owner_token();
    protocol->OnIncomingAudio([this, token](std::unique_ptr<AudioStreamPacket> packet) {
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        if (CurrentState() == XiaozhiState::kSpeaking)
            audio_->PushPacketToDecodeQueue(std::move(packet));
    });
    protocol->OnIncomingJson([this, token](const cJSON* root) {
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        HandleIncomingJson(root);
    });
    protocol->OnAudioChannelClosed([this, token]() {
        ESP_LOGD(kTag, "audio channel closed token=%lu current=%lu", static_cast<unsigned long>(token),
                 static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)));
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        SetStoppingIfMayRun(xiaozhi_phase_);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        audio_->EnableVoiceProcessing(false);
        audio_->ResetDecoder();
        if (CurrentState() != XiaozhiState::kError)
            SetState(XiaozhiState::kStopping, "小智正在收尾...");
    });
    protocol->OnNetworkError([this, token](const std::string& message) {
        ESP_LOGW(kTag, "network error token=%lu current=%lu message=%s", static_cast<unsigned long>(token),
                 static_cast<unsigned long>(conversation_token_.load(std::memory_order_acquire)), message.c_str());
        if (token != conversation_token_.load(std::memory_order_acquire))
            return;
        SetStoppingIfMayRun(xiaozhi_phase_);
        pending_listen_after_playback_.store(false, std::memory_order_relaxed);
        audio_->EnableVoiceProcessing(false);
        audio_->ResetDecoder();
        SetError(message.empty() ? "小智网络异常" : message);
    });
}

XiaozhiSnapshot XiaozhiService::Snapshot() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_;
}

void XiaozhiService::HandleIncomingJson(const cJSON* root) {
    const IncomingMessage message = ParseIncomingMessage(root);
    switch (message.kind) {
        case IncomingMessageKind::kTtsStart:
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            audio_->EnableVoiceProcessing(false);
            audio_->ResetDecoder();
            SetState(XiaozhiState::kSpeaking, "小智回复中");
            break;
        case IncomingMessageKind::kTtsStop:
            if (ConversationMayRun(xiaozhi_phase_.load(std::memory_order_relaxed))) {
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
            ESP_LOGW(kTag, "alert ignored reason=message_missing");
            break;
        case IncomingMessageKind::kNone:
            break;
    }
}

void XiaozhiService::SetState(XiaozhiState state, const std::string& status) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state        = state;
        snapshot_.has_protocol = settings::HasProtocolConfig();
        if (!status.empty())
            snapshot_.status = status;
        if (state == XiaozhiState::kReadyIdle)
            snapshot_.emotion = "neutral";
        if (state == XiaozhiState::kReadyIdle) {
            snapshot_.messages.clear();
            snapshot_.user_text.clear();
            snapshot_.assistant_text.clear();
        }
        if (state != XiaozhiState::kAwaitingActivation) {
            snapshot_.activation_message.clear();
            snapshot_.activation_code.clear();
        }
        if (state != XiaozhiState::kError)
            snapshot_.error.clear();
    }
    PostChanged();
}

void XiaozhiService::SetError(const std::string& error) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state        = XiaozhiState::kError;
        snapshot_.status       = "小智异常";
        snapshot_.emotion      = "sad";
        snapshot_.error        = error;
        snapshot_.has_protocol = settings::HasProtocolConfig();
        ClearAlertLocked();
    }
    PostChanged();
}

void XiaozhiService::SetActivation(const std::string& message, const std::string& code) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state              = XiaozhiState::kAwaitingActivation;
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

void XiaozhiService::SetUserText(const std::string& text) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.user_text = text;
        if (!text.empty())
            snapshot_.messages.push_back({"user", text});
        TrimMessagesLocked();
    }
    PostChanged();
}

void XiaozhiService::SetAssistantText(const std::string& text) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.assistant_text = text;
        if (!text.empty())
            snapshot_.messages.push_back({"assistant", text});
        TrimMessagesLocked();
    }
    PostChanged();
}

void XiaozhiService::SetAlert(const std::string& status, const std::string& message, const std::string& emotion) {
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

void XiaozhiService::ClearAlertLocked() {
    snapshot_.alert_active = false;
    snapshot_.alert_status.clear();
    snapshot_.alert_message.clear();
    snapshot_.alert_emotion.clear();
}

void XiaozhiService::TrimMessagesLocked() {
    if (snapshot_.messages.size() > 12)
        snapshot_.messages.erase(snapshot_.messages.begin(),
                                 snapshot_.messages.begin() + (snapshot_.messages.size() - 12));
}

XiaozhiState XiaozhiService::CurrentState() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_.state;
}

void XiaozhiService::PostChanged() {
    evt::PostSimple(UiEventKind::kXiaozhiChanged, pdMS_TO_TICKS(50));
}

}  // namespace xiaozhi
