#pragma once

// 启动占位屏。boot 后立即 Push 到栈底，等 SyncService 派发 GroupReady 后
// Replace 成 FrameScene。无 cred 时 captive portal 在 background 跑，splash
// 持续显示"正在启动…"直到 portal 写完凭据 + esp_restart 重启回 boot 流程。

#include "../app/scene.h"

class BootSplashScene : public Scene {
   public:
    const char* Name() const override { return "BootSplash"; }
    void OnEnter(SceneContext& ctx) override;
    void OnExit (SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override { return root_; }

   private:
    lv_obj_t* root_  = nullptr;
    lv_obj_t* label_ = nullptr;
};
