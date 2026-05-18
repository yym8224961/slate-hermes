#pragma once

// 同步频率子页: MenuList 选择预设项, ENTER 确认后返回。

#include <memory>

#include "scene.h"
#include "status_bar.h"

class MenuList;

class PollIntervalPage : public Scene {
   public:
    PollIntervalPage();
    ~PollIntervalPage() override;

    const char* Name() const override {
        return "PollInterval";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void SyncRender(SceneContext& ctx);

    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
    std::unique_ptr<MenuList>  menu_;
};
