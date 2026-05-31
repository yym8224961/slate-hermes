#pragma once

// Settings 子页面体量小且只被设置菜单创建，集中在一个编译单元降低文件噪音。

#include <memory>
#include <string>
#include <vector>

#include "scenes/core/scene.h"
#include "scenes/settings/settings_page_base.h"
#include "ui/status_bar.h"

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

class VolumePage : public SettingsPageBase {
   public:
    VolumePage();
    ~VolumePage() override;

    const char* Name() const override {
        return "Volume";
    }
    void OnEnter(SceneContext& ctx) override;
    void OnExit(SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;

   private:
    void        RedrawValue();
    void        ApplyLevel(SceneContext& ctx);
    void        SaveLevel(SceneContext& ctx);
    void        PlayTestTone(SceneContext& ctx);

    lv_obj_t*            bar_track_   = nullptr;
    lv_obj_t*            bar_fill_    = nullptr;
    lv_obj_t*            value_label_ = nullptr;
    lv_obj_t*            hint_label_  = nullptr;
    int                  level_       = 0;
    bool                 dirty_       = false;
    std::vector<uint8_t> test_tone_;
};

class DeviceInfoPage : public Scene {
   public:
    DeviceInfoPage();
    ~DeviceInfoPage() override;

    const char* Name() const override {
        return "DeviceInfo";
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
    void LoadStaticInfo();
    bool Refresh(SceneContext& ctx);
    void ScrollBy(SceneContext& ctx, int dy);
    void UpdateThumb();

    lv_obj_t*                  root_        = nullptr;
    lv_obj_t*                  scroll_area_ = nullptr;
    lv_obj_t*                  info_        = nullptr;
    lv_obj_t*                  thumb_       = nullptr;
    std::unique_ptr<StatusBar> status_bar_;

    std::string last_text_;
    std::string wifi_ssid_;
    std::string server_url_;
    char        mac_str_[18] = {};
};

class RestartDevicePage : public ConfirmActionPage {
   public:
    RestartDevicePage();
    ~RestartDevicePage() override;

   private:
    void Confirm(SceneContext& ctx) override;
};

class FactoryResetPage : public ConfirmActionPage {
   public:
    FactoryResetPage();
    ~FactoryResetPage() override;

   private:
    void Confirm(SceneContext& ctx) override;
};
