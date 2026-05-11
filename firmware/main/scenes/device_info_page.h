#pragma once

// 设备信息综合页:WiFi 状态/SSID/IP/RSSI、电量/电压/充电状态、合集/帧、
// MAC/固件/服务器。短按 ENTER 返回(避免误触);长按 ENTER 也返回。

#include <memory>
#include <string>

#include "../app/scene.h"
#include "../ui/status_bar.h"

class DeviceInfoPage : public Scene {
   public:
    DeviceInfoPage();
    ~DeviceInfoPage() override;

    const char* Name() const override {
        return "DeviceInfo";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    // returns true if 文本内容真的变了(用于跳过无意义 partial 刷)
    bool Refresh(SceneContext& ctx);
    void SyncRender(SceneContext& ctx);
    void ScrollBy(SceneContext& ctx, int dy);
    // 按当前 scroll_y / 内容高度刷新 thumb 几何。OnEnter / Refresh / ScrollBy 后调。
    void UpdateThumb();

    lv_obj_t* root_        = nullptr;
    lv_obj_t* scroll_area_ = nullptr;  // 可滚动容器,UP/DOWN 翻
    lv_obj_t* info_        = nullptr;  // 内容 label,在 scroll_area 内
    // 跟 MenuList 同款 2px 黑实心 thumb,挂在 root_ 而不是 scroll_area_(否则会跟着滚)。
    lv_obj_t*                  thumb_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;

    // 缓存上次拼好的整段文本。MinuteTick / Charge / Battery / Wifi 事件触发
    // Refresh 后,内容如果跟上次完全一样就不刷 EPD,避免长时间停留在本页
    // 时累计 partial 触发自动 full 闪屏。
    std::string last_text_;
};
