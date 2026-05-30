#include "xiaozhi/service/message_handler.h"

#include <cstring>

#include "utils/json_utils.h"

namespace xiaozhi {

IncomingMessage ParseIncomingMessage(const cJSON* root) {
    IncomingMessage message;
    cJSON*          type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type) || !type->valuestring)
        return message;

    if (std::strcmp(type->valuestring, "tts") == 0) {
        const std::string state = json_utils::JsonString(root, "state");
        if (state == "start") {
            message.kind = IncomingMessageKind::kTtsStart;
        } else if (state == "stop") {
            message.kind = IncomingMessageKind::kTtsStop;
        } else if (state == "sentence_start") {
            message.text = json_utils::JsonString(root, "text");
            if (!message.text.empty())
                message.kind = IncomingMessageKind::kTtsSentenceStart;
        }
        return message;
    }

    if (std::strcmp(type->valuestring, "stt") == 0) {
        message.text = json_utils::JsonString(root, "text");
        if (!message.text.empty())
            message.kind = IncomingMessageKind::kSttText;
        return message;
    }

    if (std::strcmp(type->valuestring, "llm") == 0) {
        message.emotion = json_utils::JsonString(root, "emotion");
        if (!message.emotion.empty())
            message.kind = IncomingMessageKind::kLlmEmotion;
        return message;
    }

    if (std::strcmp(type->valuestring, "alert") == 0) {
        message.status  = json_utils::JsonString(root, "status");
        message.message = json_utils::JsonString(root, "message");
        message.emotion = json_utils::JsonString(root, "emotion");
        message.kind =
            message.message.empty() ? IncomingMessageKind::kAlertMissingMessage : IncomingMessageKind::kAlert;
        return message;
    }

    return message;
}

}  // namespace xiaozhi
