#include "xiaozhi/service/chat_service.h"

#include <esp_log.h>

#include "events/event_bus.h"
#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/chat_phase.h"
#include "xiaozhi/service/message_handler.h"

namespace {
constexpr char kTag[] = "XiaoChat";
}  // namespace

namespace xiaozhi {

ChatSnapshot ChatService::Snapshot() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_;
}

void ChatService::HandleIncomingJson(const cJSON* root) {
    const IncomingMessage message = ParseIncomingMessage(root);
    switch (message.kind) {
        case IncomingMessageKind::kTtsStart:
            pending_listen_after_playback_.store(false, std::memory_order_relaxed);
            AudioService::Get().EnableVoiceProcessing(false);
            AudioService::Get().ResetDecoder();
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
