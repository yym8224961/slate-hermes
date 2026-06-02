#pragma once

#include <memory>
#include <string>
#include <vector>

#include "scenes/core/scene.h"
#include "ui/status_bar.h"

namespace hermes {
struct HermesSnapshot;
class HermesService;
}  // namespace hermes

class HermesScene : public Scene {
   public:
    const char* Name() const override { return "hermes"; }

    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override { return root_; }

   private:
    hermes::HermesService*   Service(SceneContext& ctx);
    void                     EnsureServiceStarted(SceneContext& ctx);
    void                     CreateLayout();
    void                     RenderContent();
    void                     HideContentViews();
    void                     RenderMessages(const hermes::HermesSnapshot& snap);
    void                     ClearMessages();
    void                     AppendBubble(const std::string& role, const std::string& text);
    void                     LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text);
    void                     UpdateStatusBarTitle(const hermes::HermesSnapshot& snap);
    void                     SyncAndRefresh(SceneContext& ctx);

    lv_obj_t*                root_                = nullptr;
    lv_obj_t*                standby_icon_label_  = nullptr;
    lv_obj_t*                standby_body_label_  = nullptr;
    lv_obj_t*                system_label_        = nullptr;
    lv_obj_t*                chat_area_           = nullptr;
    lv_obj_t*                chat_content_        = nullptr;
    lv_obj_t*                chat_empty_label_    = nullptr;
    lv_obj_t*                hint_label_          = nullptr;
    hermes::HermesService*   service_             = nullptr;
    bool                     service_entered_     = false;
    int                      rendered_state_      = -1;
    size_t                   rendered_msg_count_  = 0;
    std::string              rendered_msg_key_;
    std::unique_ptr<StatusBar> status_bar_;

    // Preset quick messages
    std::vector<std::string>  presets_;
    int                       preset_index_ = 0;
};
