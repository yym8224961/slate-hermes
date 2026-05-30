#pragma once

#include <atomic>

#include "xiaozhi/service/chat_service.h"

namespace xiaozhi {

inline bool ConversationMayRun(ChatPhase phase) {
    return phase == ChatPhase::kStarting || phase == ChatPhase::kRunning;
}

inline bool ConversationBlocksSleep(ChatPhase phase) {
    return phase != ChatPhase::kIdle;
}

inline bool SetStoppingIfMayRun(std::atomic<ChatPhase>& phase) {
    auto current = phase.load(std::memory_order_relaxed);
    while (ConversationMayRun(current)) {
        if (phase.compare_exchange_weak(current, ChatPhase::kStopping, std::memory_order_relaxed))
            return true;
    }
    return false;
}

inline bool ConversationStopOrRestartPending(ChatPhase phase) {
    return phase == ChatPhase::kStopping || phase == ChatPhase::kStartPending;
}

}  // namespace xiaozhi
