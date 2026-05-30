#include "scenes/core/scene_stack.h"

#include <utility>

#include <esp_log.h>
#include "events/event_bus.h"
#include "utils/time_utils.h"

namespace {
constexpr char kTag[] = "SceneStack";

constexpr int     kRootRetryMinDelayMs        = 500;
constexpr int     kRootRetryMaxDelayMs        = 8000;
constexpr uint8_t kRootRetryAttemptCounterMax = 0xFF;

int RootRetryDelayMs(uint8_t retry_count) {
    int delay = kRootRetryMinDelayMs;
    for (uint8_t i = 1; i < retry_count && delay < kRootRetryMaxDelayMs; ++i) {
        delay *= 2;
        if (delay > kRootRetryMaxDelayMs)
            delay = kRootRetryMaxDelayMs;
    }
    return delay;
}
}  // namespace

void SceneStack::ResetRootRetry() {
    root_retry_scene_   = nullptr;
    next_root_retry_ms_ = 0;
    root_retry_count_   = 0;
}

void SceneStack::Push(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    ResetRootRetry();
    if (Top())
        Top()->OnExit(ctx_);
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
}

void SceneStack::Pop() {
    if (stack_.empty())
        return;
    ResetRootRetry();
    Top()->OnExit(ctx_);
    stack_.pop_back();
    if (Top())
        Top()->OnEnter(ctx_);
}

void SceneStack::Replace(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    ResetRootRetry();
    if (Top()) {
        Top()->OnExit(ctx_);
        stack_.pop_back();
    }
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
}

void SceneStack::RequestPush(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    pending_ops_.push_back({PendingKind::kPush, std::move(s)});
}

void SceneStack::RequestPop() {
    pending_ops_.push_back({PendingKind::kPop, nullptr});
}

void SceneStack::RequestReplace(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    pending_ops_.push_back({PendingKind::kReplace, std::move(s)});
}

void SceneStack::ApplyPending() {
    auto ops = std::move(pending_ops_);
    for (auto& op : ops) {
        switch (op.kind) {
            case PendingKind::kPush:
                Push(std::move(op.scene));
                break;
            case PendingKind::kPop:
                Pop();
                break;
            case PendingKind::kReplace:
                Replace(std::move(op.scene));
                break;
        }
    }
}

void SceneStack::Dispatch(const UiEvent& e) {
    Scene* top = Top();
    if (!top)
        return;
    if (top->RequiresRoot() && !top->Root()) {
        const int64_t now_ms = time_utils::NowMs();
        if (top != root_retry_scene_) {
            root_retry_scene_   = top;
            next_root_retry_ms_ = 0;
            root_retry_count_   = 0;
        }
        if (now_ms >= next_root_retry_ms_) {
            if (root_retry_count_ < kRootRetryAttemptCounterMax)
                ++root_retry_count_;
            ESP_LOGW(kTag, "Retry OnEnter for scene without root: %s attempt=%u", top->Name(),
                     static_cast<unsigned>(root_retry_count_));
            top->OnEnter(ctx_);
            next_root_retry_ms_ = now_ms + RootRetryDelayMs(root_retry_count_);
        }
        if (!top->RequiresRoot() || top->Root())
            ResetRootRetry();
        if (top->RequiresRoot() && !top->Root() && e.kind != UiEventKind::kButtonLong &&
            e.kind != UiEventKind::kButtonDouble)
            return;
    } else if (top == root_retry_scene_) {
        ResetRootRetry();
    }
    top->OnEvent(ctx_, e);
}
