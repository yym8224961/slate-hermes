#pragma once

#include <memory>
#include <string>

#include "scene.h"
#include "status_bar.h"

class EpdSsd1683;

class BgRefreshScene : public Scene {
   public:
    ~BgRefreshScene() override;

    const char* Name() const override {
        return "BgRefresh";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    enum class State {
        kWaiting,
        kRendering,
        kDone,
    };

    bool SeedPreviousFrame(SceneContext& ctx);
    bool ResolveCurrentFrame(std::string& gid, int& seq, int& content_count);
    bool RenderChangedFrame(SceneContext& ctx);
    void StartWatcher(EpdSsd1683* epd);
    void Finish();

    State state_                  = State::kWaiting;
    bool  previous_screen_seeded_ = false;

    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
};
