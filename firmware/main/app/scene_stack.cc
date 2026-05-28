#include "scene_stack.h"

#include <utility>

#include "esp_log.h"
#include "event_bus.h"

namespace {
constexpr char kTag[] = "SceneStack";
}

void SceneStack::Push(std::unique_ptr<Scene> s) {
    if (!s)
        return;
    if (Top())
        Top()->OnExit(ctx_);
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
}

void SceneStack::Pop() {
    if (stack_.empty())
        return;
    Top()->OnExit(ctx_);
    stack_.pop_back();
    if (Top())
        Top()->OnEnter(ctx_);
}

void SceneStack::Replace(std::unique_ptr<Scene> s) {
    if (!s)
        return;
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
        ESP_LOGW(kTag, "Retry OnEnter for scene without root: %s", top->Name());
        top->OnEnter(ctx_);
        if (top->RequiresRoot() && !top->Root() && e.kind != UiEventKind::kButtonLong &&
            e.kind != UiEventKind::kButtonDouble)
            return;
    }
    top->OnEvent(ctx_, e);
}
