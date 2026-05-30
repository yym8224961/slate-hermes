#pragma once

// 重启设备子页:警告 + 长按确认 + esp_restart。NVS / 缓存都保留(只是简单重启)。
// 短按 ENTER = 取消并 pop 回设置主菜单(避免误触)。

#include "scenes/settings/pages/confirm_action_page.h"

class RestartDevicePage : public ConfirmActionPage {
   public:
    RestartDevicePage();
    ~RestartDevicePage() override;

   private:
    void Confirm(SceneContext& ctx) override;
};
