#pragma once

// 恢复出厂设置子页:警告 + 长按确认 + 清 NVS 重启进配网。
// 短按 ENTER = 取消并 pop 回设置主菜单(避免误触)。

#include <memory>

#include "scene.h"
#include "status_bar.h"

class FactoryResetPage : public Scene {
   public:
    FactoryResetPage();
    ~FactoryResetPage() override;

    const char* Name() const override {
        return "FactoryReset";
    }
    bool IsSettings() const override {
        return true;
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
};
