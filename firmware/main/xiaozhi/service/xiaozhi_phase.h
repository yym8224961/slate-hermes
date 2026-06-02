#pragma once

#include <atomic>

#include "xiaozhi/service/xiaozhi_service.h"

namespace xiaozhi {

inline bool ConversationMayRun(XiaozhiPhase phase) {
    return phase == XiaozhiPhase::kStarting || phase == XiaozhiPhase::kRunning;
}

inline bool ConversationBlocksSleep(XiaozhiPhase phase) {
    return phase != XiaozhiPhase::kIdle;
}

inline bool SetStoppingIfMayRun(std::atomic<XiaozhiPhase>& phase) {
    auto current = phase.load(std::memory_order_relaxed);
    while (ConversationMayRun(current)) {
        if (phase.compare_exchange_weak(current, XiaozhiPhase::kStopping, std::memory_order_relaxed))
            return true;
    }
    return false;
}

inline bool ConversationStopOrRestartPending(XiaozhiPhase phase) {
    return phase == XiaozhiPhase::kStopping || phase == XiaozhiPhase::kStartPending;
}

}  // namespace xiaozhi
