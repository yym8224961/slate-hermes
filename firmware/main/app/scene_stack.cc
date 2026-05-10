#include "scene_stack.h"

#include <esp_log.h>

#include "event_bus.h"

namespace {
constexpr char kTag[] = "Scene";
}

void SceneStack::Push(std::unique_ptr<Scene> s) {
    if (!s) return;
    if (Top()) Top()->OnExit(ctx_);
    ESP_LOGI(kTag, "Push %s", s->Name());
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
}

void SceneStack::Pop() {
    if (stack_.empty()) return;
    ESP_LOGI(kTag, "Pop  %s", Top()->Name());
    Top()->OnExit(ctx_);
    stack_.pop_back();
    if (Top()) Top()->OnEnter(ctx_);
}

void SceneStack::Replace(std::unique_ptr<Scene> s) {
    if (!s) return;
    if (Top()) {
        ESP_LOGI(kTag, "Replace %s -> %s", Top()->Name(), s->Name());
        Top()->OnExit(ctx_);
        stack_.pop_back();
    } else {
        ESP_LOGI(kTag, "Replace [empty] -> %s", s->Name());
    }
    stack_.push_back(std::move(s));
    Top()->OnEnter(ctx_);
}

void SceneStack::RequestPush(std::unique_ptr<Scene> s) {
    pending_kind_  = PendingKind::kPush;
    pending_scene_ = std::move(s);
}

void SceneStack::RequestPop() {
    pending_kind_ = PendingKind::kPop;
    pending_scene_.reset();
}

void SceneStack::RequestReplace(std::unique_ptr<Scene> s) {
    pending_kind_  = PendingKind::kReplace;
    pending_scene_ = std::move(s);
}

void SceneStack::ApplyPending() {
    PendingKind k = pending_kind_;
    pending_kind_ = PendingKind::kNone;
    auto s        = std::move(pending_scene_);
    switch (k) {
        case PendingKind::kPush:    Push(std::move(s));    break;
        case PendingKind::kPop:     Pop();                  break;
        case PendingKind::kReplace: Replace(std::move(s));  break;
        case PendingKind::kNone:    default:                break;
    }
}

void SceneStack::Dispatch(const UiEvent& e) {
    Scene* top = Top();
    if (!top) return;
    top->OnEvent(ctx_, e);
}
