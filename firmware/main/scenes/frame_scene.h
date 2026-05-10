#pragma once

// 主场景：渲染当前 group 的 frame[idx]，顶部 24px 状态栏叠加。
// 阶段 1 行为：
//   ButtonShort{kUp}            → idx-- (wrap)
//   ButtonShort{kDown,kEnter}   → idx++ (wrap)
//   ButtonLong{kUp,kDown,kEnter}→ 仅 log TODO（阶段 2/3 接）
//   ChargeChanged / BatteryUpdated / WifiStateChanged → 更新状态栏
//   GroupReady                  → 如 gid 变了，重新 Rebind + LoadFrame default
//   SyncStarted/Finished        → 状态栏同步图标
//   MinuteTick                  → 重读 wifi/battery 喂状态栏

#include <memory>
#include <string>

#include "../app/scene.h"

class StatusBar;
class FrameView;

class FrameScene : public Scene {
   public:
    FrameScene(const char* gid, int frame_count, int default_idx);
    ~FrameScene() override;

    const char* Name() const override {
        return "Frame";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void LoadFrame(SceneContext& ctx, int idx, bool force_full);
    void NextFrame(SceneContext& ctx);
    void PrevFrame(SceneContext& ctx);
    void RebindGroup(SceneContext& ctx, const char* gid, int frame_count, int default_idx);
    void RefreshStatusBarFromSensors(SceneContext& ctx);
    // 根据 frame_count_ 切换「空相册提示」与 frame_view 的可见性。
    void ApplyEmptyState();
    // 持锁同步渲染 + 触发 partial/full refresh。改 status_bar 后必调,
    // 否则 LVGL 异步路径常在 RefreshTask 50ms debounce 之后才 flush,
    // refresh_task 拿到 prev=cur Diff=0 直接跳过,表现为图标不刷新。
    void SyncRender(SceneContext& ctx, bool force_full);

    std::string gid_;
    int         frame_count_  = 0;
    int         idx_          = 0;
    bool        first_loaded_ = false;
    std::string cached_caption_;  // 当前 frame 的 caption,SyncProgress 临时占用 caption 区后用来恢复

    lv_obj_t*                  root_        = nullptr;
    lv_obj_t*                  empty_label_ = nullptr;  // frame_count_<=0 时显示「相册暂无图片」
    std::unique_ptr<FrameView> frame_view_;
    std::unique_ptr<StatusBar> status_bar_;
};
