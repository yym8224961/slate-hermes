#pragma once

// 音量子页：0~10 级，UP/DOWN 调，ENTER 短按播 200 ms 测试音，ENTER 长按 pop。

#include <memory>

#include "scene.h"
#include "status_bar.h"

class VolumePage : public Scene {
   public:
    enum class Target { kAlbum, kXiaozhi };

    explicit VolumePage(Target target = Target::kAlbum);
    ~VolumePage() override;

    const char* Name() const override {
        return "Volume";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void RedrawValue();
    void SaveLevel();
    const char* Caption() const;
    void SyncRender(SceneContext& ctx);
    void PlayTestTone(SceneContext& ctx);

    lv_obj_t*                  root_        = nullptr;
    lv_obj_t*                  bar_track_   = nullptr;  // 进度条底
    lv_obj_t*                  bar_fill_    = nullptr;  // 进度条填充(黑实心)
    lv_obj_t*                  value_label_ = nullptr;  // "6 / 10"
    lv_obj_t*                  hint_label_  = nullptr;  // 底部提示
    std::unique_ptr<StatusBar> status_bar_;
    Target                     target_ = Target::kAlbum;
    int                        level_ = 0;
};
