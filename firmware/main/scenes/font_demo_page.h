#pragma once

// 字体 A/B 测试页:UP/DOWN 切换 4 种中文字体显示同一段测试文本,
// 用于现场对比 1bpp EPD 渲染效果。短按 ENTER 全屏刷新清残影,长按 ENTER pop。
// 字体子集仅含 89 个常用中文 + ASCII + 全角标点,出现 ".notdef" 是字体覆盖问题
// 不是渲染问题(尤其 ArkPixel zh_cn 当前还在补字)。

#include <memory>

#include "../app/scene.h"
#include "../ui/status_bar.h"

class FontDemoPage : public Scene {
   public:
    FontDemoPage();
    ~FontDemoPage() override;

    const char* Name() const override {
        return "FontDemo";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void ApplyFont();
    void SyncRender(SceneContext& ctx, bool force_full = false);

    lv_obj_t*                  root_     = nullptr;
    lv_obj_t*                  name_lbl_ = nullptr;  // 当前字体名(用思源)
    lv_obj_t*                  body_lbl_ = nullptr;  // 测试文本(用演示字体)
    lv_obj_t*                  hint_lbl_ = nullptr;  // 底部操作提示(用思源)
    int                        idx_      = 0;        // 当前字体索引
    std::unique_ptr<StatusBar> status_bar_;
};
