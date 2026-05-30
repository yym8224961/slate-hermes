#pragma once

// 音量子页：0~10 级，UP/DOWN 调，ENTER 短按播 200 ms 测试音，ENTER 长按 pop。

#include <memory>
#include <vector>

#include "settings_page_base.h"

class VolumePage : public SettingsPageBase {
   public:
    enum class Target { kAlbum, kXiaozhi };

    explicit VolumePage(Target target = Target::kAlbum);
    ~VolumePage() override;

    const char* Name() const override {
        return "Volume";
    }
    void OnEnter(SceneContext& ctx) override;
    void OnExit(SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;

   private:
    void        RedrawValue();
    void        ApplyLevel();
    void        SaveLevel();
    const char* Caption() const;
    void        PlayTestTone(SceneContext& ctx);

    lv_obj_t*            bar_track_   = nullptr;  // 进度条底
    lv_obj_t*            bar_fill_    = nullptr;  // 进度条填充(黑实心)
    lv_obj_t*            value_label_ = nullptr;  // "6 / 10"
    lv_obj_t*            hint_label_  = nullptr;  // 底部提示
    Target               target_      = Target::kAlbum;
    int                  level_       = 0;
    bool                 dirty_       = false;
    std::vector<uint8_t> test_tone_;
};
