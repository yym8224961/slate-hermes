#pragma once

// 数据同步页:扁平单页,无子菜单。
//   - 短按 ENTER     = 返回设置主菜单
//   - 长按 ENTER     = 立即触发一次同步(SyncService::TriggerNow)
// 中央显示当前同步状态(等待 / 同步中 N/M / 完成 / 失败),
// 监听 kSyncStarted/Progress/Finished 自动更新。

#include <memory>
#include <string>

#include "../app/scene.h"
#include "../ui/status_bar.h"

class DataSyncPage : public Scene {
   public:
    DataSyncPage();
    ~DataSyncPage() override;

    const char* Name() const override { return "DataSync"; }
    void OnEnter(SceneContext& ctx) override;
    void OnExit (SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override { return root_; }

   private:
    void SetStatus(SceneContext& ctx, const std::string& text);
    void SyncRender(SceneContext& ctx);

    lv_obj_t*                  root_         = nullptr;
    lv_obj_t*                  status_lbl_   = nullptr;  // 中央大字状态
    lv_obj_t*                  hint_lbl_     = nullptr;  // 底部按键提示
    std::unique_ptr<StatusBar> status_bar_;
};
