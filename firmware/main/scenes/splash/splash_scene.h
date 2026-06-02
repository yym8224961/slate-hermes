#pragma once

// 启动占位屏 + 配对/等待显示。事件驱动状态机:
//   - cred::Load 失败 → kProvisioning(显示 AP SSID)
//   - kBootStage event 切到对应阶段(连 Wi-Fi / 对时 / 注册中 / 配对码 ...)
//   - kBound → kAwaitingGroup;kUnbound → kAwaitingPair(载新码)
//   - kSyncProgress → 帧级下载进度;kSyncFinished{ok=false} → 网络异常
//   - kCachedGroupReady / kSyncedGroupReady → RequestReplace 切 FrameScene
//
// 配对码 6 字符用 montserrat_48 大字号居中显示,确保用户对屏抄码一眼能看清。

#include <freertos/FreeRTOS.h>

#include <cstdint>

#include "scenes/core/scene.h"

class SplashScene : public Scene {
   public:
    enum class State : uint8_t {
        kInitializing = 0,
        kProvisioning,
        kWifiConnecting,
        kWifiFailed,
        kSntp,
        kRegistering,
        kServerUnreachable,
        kAwaitingPair,
        kAwaitingGroup,
        kNetError,
        kSyncProgress,
    };

    const char* Name() const override {
        return "splash";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void CreateLayout();
    void RenderContent();
    void Render(SceneContext& ctx);

    State   state_             = State::kInitializing;
    char    ssid_[33]          = {0};
    char    pair_code_[8]      = {0};
    char    progress_name_[48] = {0};
    uint8_t progress_cur_      = 0;
    uint8_t progress_total_    = 0;

    lv_obj_t* root_       = nullptr;
    lv_obj_t* text_label_ = nullptr;  // 主文案(中文,Zfull)
    lv_obj_t* code_label_ = nullptr;  // 配对码大字(montserrat_48,仅 kAwaitingPair 显示)
    lv_obj_t* hint_label_ = nullptr;  // 底部应急逃生 hint

    // 进度节流:启动期下载几十帧时,SyncProgress 高频触发,需要节流避免
    // EPD 累计 8 次 partial 自动升 full 闪屏。
    uint8_t    last_progress_current_ = 0xFF;
    TickType_t last_progress_tick_    = 0;
};
