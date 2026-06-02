#pragma once

#include <memory>
#include <string>

#include "scenes/core/scene.h"
#include "ui/status_bar.h"

namespace xiaozhi {
struct XiaozhiSnapshot;
class XiaozhiService;
}  // namespace xiaozhi

class XiaozhiScene : public Scene {
   public:
    const char* Name() const override {
        return "xiaozhi";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void                     EnsureServiceStarted(SceneContext& ctx);
    xiaozhi::XiaozhiService* Service(SceneContext& ctx);
    void                     CreateLayout();
    void                     Render(SceneContext& ctx, bool full = false);
    void                     RenderContent();
    void                     HideContentViews();
    void                     RenderSystemMessage(const std::string& text, bool show_code, const std::string& code);
    void                     RenderXiaozhiMessages(const xiaozhi::XiaozhiSnapshot& snap);
    void                     ClearXiaozhiMessages();
    void                     ShowEmptyXiaozhiHint();
    void                     AppendXiaozhiBubble(const std::string& role, const std::string& text);
    void                     LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text);
    void                     UpdateStatusBarTitle(const xiaozhi::XiaozhiSnapshot& snap);

    lv_obj_t*                  root_                   = nullptr;
    lv_obj_t*                  standby_icon_label_     = nullptr;
    lv_obj_t*                  standby_body_label_     = nullptr;
    lv_obj_t*                  system_label_           = nullptr;
    lv_obj_t*                  code_label_             = nullptr;
    lv_obj_t*                  xiaozhi_area_           = nullptr;
    lv_obj_t*                  xiaozhi_content_        = nullptr;
    lv_obj_t*                  xiaozhi_empty_label_    = nullptr;
    lv_obj_t*                  hint_label_             = nullptr;
    xiaozhi::XiaozhiService*   service_                = nullptr;
    int                        rendered_state_         = 0;
    bool                       service_entered_        = false;
    size_t                     rendered_message_count_ = 0;
    std::string                rendered_messages_key_;
    std::unique_ptr<StatusBar> status_bar_;
};
