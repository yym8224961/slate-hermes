#pragma once

#include <functional>
#include <memory>

#include "scenes/core/scene.h"
#include "ui/status_bar.h"

class SettingsPageBase : public Scene {
   public:
    bool IsSettings() const override {
        return true;
    }

    lv_obj_t* Root() override {
        return root_;
    }

   protected:
    bool      EnterSettingsScaffold(SceneContext& ctx, const char* caption);
    void      FinishSettingsScaffoldEnter(SceneContext& ctx);
    void      ExitSettingsScaffold(SceneContext& ctx, std::function<void()> cleanup = {});
    lv_obj_t* CreateBottomHint(const char* text);

    lv_obj_t* RootObj() const {
        return root_;
    }
    StatusBar* Status() const {
        return status_bar_.get();
    }

   private:
    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
};
