#pragma once

#include <functional>
#include <string>

#include "settings_page_base.h"

class ConfirmActionPage : public SettingsPageBase {
   public:
    using ConfirmCallback = std::function<void(SceneContext&)>;

    ConfirmActionPage(std::string name, std::string caption, std::string warning, ConfirmCallback on_confirm);
    ~ConfirmActionPage() override;

    const char* Name() const override {
        return name_.c_str();
    }
    void OnEnter(SceneContext& ctx) override;
    void OnExit(SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;

   private:
    std::string     name_;
    std::string     caption_;
    std::string     warning_;
    ConfirmCallback on_confirm_;
};
