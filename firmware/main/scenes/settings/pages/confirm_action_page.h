#pragma once

#include <string>

#include "scenes/settings/settings_page_base.h"

class ConfirmActionPage : public SettingsPageBase {
   public:
    ConfirmActionPage(std::string name, std::string caption, std::string warning);
    ~ConfirmActionPage() override;

    const char* Name() const override {
        return name_.c_str();
    }
    void OnEnter(SceneContext& ctx) override;
    void OnExit(SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;

   protected:
    virtual void Confirm(SceneContext& ctx) = 0;

   private:
    std::string name_;
    std::string caption_;
    std::string warning_;
};
