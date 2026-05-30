#pragma once

#include <cJSON.h>

#include <string>

namespace xiaozhi {

enum class IncomingMessageKind {
    kNone,
    kTtsStart,
    kTtsStop,
    kTtsSentenceStart,
    kSttText,
    kLlmEmotion,
    kAlert,
    kAlertMissingMessage,
};

struct IncomingMessage {
    IncomingMessageKind kind = IncomingMessageKind::kNone;
    std::string         text;
    std::string         status;
    std::string         message;
    std::string         emotion;
};

IncomingMessage ParseIncomingMessage(const cJSON* root);

}  // namespace xiaozhi
