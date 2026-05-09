#pragma once

// 设备信息综合页:WiFi 状态/SSID/IP/RSSI、电量/电压/充电状态、合集/帧、
// MAC/固件/服务器。短按 ENTER 返回(避免误触);长按 ENTER 也返回。

#include <memory>

#include "../app/scene.h"
#include "../ui/status_bar.h"

class DeviceInfoPage : public Scene {
   public:
    DeviceInfoPage();
    ~DeviceInfoPage() override;

    const char* Name() const override { return "DeviceInfo"; }
    void OnEnter(SceneContext& ctx) override;
    void OnExit (SceneContext& ctx) override;
    void OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override { return root_; }

   private:
    void Refresh(SceneContext& ctx);
    void SyncRender(SceneContext& ctx);
    void ScrollBy(SceneContext& ctx, int dy);

    lv_obj_t*                  root_           = nullptr;
    lv_obj_t*                  scroll_area_    = nullptr;  // 可滚动容器,UP/DOWN 翻
    lv_obj_t*                  info_           = nullptr;  // 内容 label,在 scroll_area 内
    std::unique_ptr<StatusBar> status_bar_;
};
