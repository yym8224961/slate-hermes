#pragma once

// 恢复出厂设置子页:警告 + 长按确认 + 清 NVS 重启进配网。
// 短按 ENTER = 取消并 pop 回设置主菜单(避免误触)。

#include "scenes/settings/pages/confirm_action_page.h"

class FactoryResetPage : public ConfirmActionPage {
   public:
    FactoryResetPage();
    ~FactoryResetPage() override;

   private:
    void Confirm(SceneContext& ctx) override;
};
