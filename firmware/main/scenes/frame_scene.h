#pragma once

// 主场景：渲染当前 group 的 frame[idx]，顶部 24px 状态栏叠加。
// 按键行为：
//   ButtonShort{kUp}            → idx-- (wrap)
//   ButtonShort{kDown,kEnter}   → idx++ (wrap)
//   ButtonLong{kUp,kDown}       → 立即提示并切换 group
//   ButtonLong{kEnter}          → push SettingsScene
//   ChargeChanged / BatteryUpdated / WifiStateChanged → 更新状态栏
//   GroupReady                  → 如 gid 变了，重新 Rebind + LoadFrame
//   SyncStarted/Finished        → 状态栏同步图标
//   MinuteTick                  → 重读 Wi-Fi/battery 喂状态栏

#include <memory>
#include <string>

#include "../app/scene.h"

class StatusBar;
class FrameView;

// 当前展示帧的 sort_order（FrameScene 持有；SyncService telemetry 用）。
// 用全局 getter 而非通过 SyncDeps 注入：SyncService 在 InitNetwork 启动时 FrameScene
// 还未实例化，lambda 必须延迟解析；统一从这里读最简单。
//
// FrameScene 维护 idx_ 时同步写入；FrameScene 销毁后这个值停留在最后值（设备进 sleep
// 前的最后一帧），SyncService 唤醒后第一次 telemetry 直接复用，符合预期。
namespace frame_scene_state {
int GetCurrentSeq();
}  // namespace frame_scene_state

class FrameScene : public Scene {
   public:
    FrameScene(const char* gid, int content_count);
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
    void CycleGroup(SceneContext& ctx, bool next);
    void RebindGroup(SceneContext& ctx, const char* gid, int content_count);
    void RefreshStatusBarFromSensors(SceneContext& ctx);
    // 根据 content_count_ 切换「空相册提示」与 frame_view 的可见性。
    void ApplyEmptyState();
    // 持锁同步渲染 + 触发 partial/full refresh。改 status_bar 后必调,
    // 否则 LVGL 异步路径常在 RefreshTask 50 ms debounce 之后才 flush，
    // refresh_task 拿到 prev=cur Diff=0 直接跳过,表现为图标不刷新。
    void SyncRender(SceneContext& ctx, bool force_full);

    std::string gid_;
    int         content_count_  = 0;
    int         idx_          = 0;
    bool        first_loaded_ = false;
    std::string cached_caption_;  // 当前 frame 的 caption,SyncProgress 临时占用 caption 区后用来恢复

    lv_obj_t*                  root_        = nullptr;
    lv_obj_t*                  empty_label_ = nullptr;  // content_count_<=0 时显示空相册提示
    std::unique_ptr<FrameView> frame_view_;
    std::unique_ptr<StatusBar> status_bar_;
};
