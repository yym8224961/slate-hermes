#pragma once

// 场景栈：活跃态通常以 FrameScene 为根；配网和后台刷新也可作为启动根场景。
// 其他 Scene（设置页 / 子菜单）push 在当前根场景之上。
// 所有同步切换方法（Push/Pop/Replace）只能由 ui_loop task 调用，否则 LVGL 不安全。
// Scene::OnEvent 内若需切换，应调 RequestX；ui_loop 在 Dispatch 后调 ApplyPending。

#include <memory>
#include <vector>

#include "scene.h"

class SceneStack {
   public:
    SceneStack() = default;

    void SetContext(const SceneContext& ctx) {
        ctx_ = ctx;
    }
    SceneContext& Context() {
        return ctx_;
    }

    // 同步切换（仅 ui_loop 调）
    void Push(std::unique_ptr<Scene> s);
    void Pop();
    void Replace(std::unique_ptr<Scene> s);

    Scene* Top() const {
        return stack_.empty() ? nullptr : stack_.back().get();
    }
    bool Empty() const {
        return stack_.empty();
    }

    // 给 Scene::OnEvent 内用的 deferred 切换。Apply 时 ui_loop 取出执行。
    void RequestPush(std::unique_ptr<Scene> s);
    void RequestPop();
    void RequestReplace(std::unique_ptr<Scene> s);

    // ui_loop 每次 Dispatch 后调一次。
    void ApplyPending();

    // 把事件分发给栈顶。阶段 1 仅给 Top()；状态类事件（charge/wifi/sync）也是
    // 给 Top() 即可，因为子 Scene 不可见时本来就不该处理。
    void Dispatch(const UiEvent& e);

   private:
    enum class PendingKind { kPush, kPop, kReplace };
    struct PendingOp {
        PendingKind            kind;
        std::unique_ptr<Scene> scene;
    };

    SceneContext                        ctx_;
    std::vector<std::unique_ptr<Scene>> stack_;
    std::vector<PendingOp>              pending_ops_;
};
