#pragma once

#include <memory>
#include <string>

#include "scene.h"
#include "status_bar.h"
#include "xiaozhi_chat_service.h"

namespace xiaozhi {
struct ChatSnapshot;
}

class ChatScene : public Scene {
   public:
    const char* Name() const override {
        return "Xiaozhi";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void EnsureServiceStarted(SceneContext& ctx);
    void Render(SceneContext& ctx, bool full = false);
    void RenderContent();
    void HideContentViews();
    void RenderSystemMessage(const std::string& text, bool show_code, const std::string& code);
    void RenderChatMessages(const xiaozhi::ChatSnapshot& snap);
    void ClearChatMessages();
    void ShowEmptyChatHint();
    void AppendChatBubble(const std::string& role, const std::string& text);
    void LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text, bool user);
    void UpdateStatusBarTitle(const xiaozhi::ChatSnapshot& snap);

    lv_obj_t*                  root_                   = nullptr;
    lv_obj_t*                  standby_icon_label_     = nullptr;
    lv_obj_t*                  standby_body_label_     = nullptr;
    lv_obj_t*                  system_label_           = nullptr;
    lv_obj_t*                  code_label_             = nullptr;
    lv_obj_t*                  chat_area_              = nullptr;
    lv_obj_t*                  chat_content_           = nullptr;
    lv_obj_t*                  chat_empty_label_       = nullptr;
    lv_obj_t*                  hint_label_             = nullptr;
    xiaozhi::ChatState         rendered_state_         = xiaozhi::ChatState::kCheckingConfig;
    bool                       service_entered_        = false;
    size_t                     rendered_message_count_ = 0;
    std::string                rendered_messages_key_;
    std::unique_ptr<StatusBar> status_bar_;
};
