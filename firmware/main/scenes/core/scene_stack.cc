#include "scenes/core/scene_stack.h"

#include <utility>

#include <esp_log.h>
#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "utils/time_utils.h"

namespace {
constexpr char kTag[] = "scene_stack";

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
    const char* from = Top() ? Top()->Name() : "(none)";
    const char* to   = s->Name();
    ESP_LOGD(kTag, "push from=%s to=%s depth_before=%u", from, to, static_cast<unsigned>(stack_.size()));
    ResetRootRetry();
    if (Top())
        Top()->OnExit(ctx_);
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
    ESP_LOGD(kTag, "push done top=%s depth=%u root=%p", Top() ? Top()->Name() : "(none)",
             static_cast<unsigned>(stack_.size()), Top() ? Top()->Root() : nullptr);
}

void SceneStack::Pop() {
    if (stack_.empty())
        return;
    const char* from = Top()->Name();
    ESP_LOGD(kTag, "pop from=%s depth_before=%u", from, static_cast<unsigned>(stack_.size()));
    ResetRootRetry();
    Top()->OnExit(ctx_);
    stack_.pop_back();
    if (Top())
        Top()->OnEnter(ctx_);
    ESP_LOGD(kTag, "pop done top=%s depth=%u root=%p", Top() ? Top()->Name() : "(none)",
             static_cast<unsigned>(stack_.size()), Top() ? Top()->Root() : nullptr);
}

void SceneStack::Replace(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    const char* from = Top() ? Top()->Name() : "(none)";
    const char* to   = s->Name();
    ESP_LOGD(kTag, "replace from=%s to=%s depth_before=%u", from, to, static_cast<unsigned>(stack_.size()));
    ResetRootRetry();
    if (Top()) {
        Top()->OnExit(ctx_);
        stack_.pop_back();
    }
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
    ESP_LOGD(kTag, "replace done top=%s depth=%u root=%p", Top() ? Top()->Name() : "(none)",
             static_cast<unsigned>(stack_.size()), Top() ? Top()->Root() : nullptr);
}

void SceneStack::RequestPush(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    ESP_LOGD(kTag, "request push scene=%s pending_before=%u", s->Name(), static_cast<unsigned>(pending_ops_.size()));
    pending_ops_.push_back({PendingKind::kPush, std::move(s)});
}

void SceneStack::RequestPop() {
    ESP_LOGD(kTag, "request pop pending_before=%u", static_cast<unsigned>(pending_ops_.size()));
    pending_ops_.push_back({PendingKind::kPop, nullptr});
}

void SceneStack::RequestReplace(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    ESP_LOGD(kTag, "request replace scene=%s pending_before=%u", s->Name(), static_cast<unsigned>(pending_ops_.size()));
    pending_ops_.push_back({PendingKind::kReplace, std::move(s)});
}

void SceneStack::ApplyPending() {
    auto ops = std::move(pending_ops_);
    if (!ops.empty()) {
        ESP_LOGD(kTag, "apply pending count=%u top=%s", static_cast<unsigned>(ops.size()),
                 Top() ? Top()->Name() : "(none)");
    }
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
    if (!top) {
        ESP_LOGD(kTag, "dispatch drop reason=no_top kind=%s", evt::log::KindName(e.kind));
        return;
    }
    if (evt::log::DebugEnabled(kTag)) {
        char detail[128];
        evt::log::Describe(e, detail, sizeof(detail));
        ESP_LOGD(kTag, "dispatch begin top=%s root=%p kind=%s detail=%s", top->Name(), top->Root(),
                 evt::log::KindName(e.kind), detail);
    }
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
            ESP_LOGW(kTag, "enter retry scene=%s reason=no_root attempt=%u", top->Name(),
                     static_cast<unsigned>(root_retry_count_));
            top->OnEnter(ctx_);
            next_root_retry_ms_ = now_ms + RootRetryDelayMs(root_retry_count_);
        }
        if (!top->RequiresRoot() || top->Root())
            ResetRootRetry();
        if (top->RequiresRoot() && !top->Root() && e.kind != UiEventKind::kButtonLong &&
            e.kind != UiEventKind::kButtonDouble) {
            ESP_LOGD(kTag, "dispatch defer top=%s reason=no_root kind=%s", top->Name(), evt::log::KindName(e.kind));
            return;
        }
    } else if (top == root_retry_scene_) {
        ResetRootRetry();
    }
    top->OnEvent(ctx_, e);
    ESP_LOGD(kTag, "dispatch done top=%s kind=%s pending=%u", top->Name(), evt::log::KindName(e.kind),
             static_cast<unsigned>(pending_ops_.size()));
}
