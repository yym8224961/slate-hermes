#pragma once

// 设置主菜单。FrameScene 的 ENTER 长按触发 push 到栈。
// UP/DOWN 短按移动光标,ENTER 短按 push 子页,ENTER 长按 pop 回 FrameScene。
// 条目超过 MenuList::kVisibleRows(6)时启用视口滚动,光标越界自动滚屏。

#include <memory>

#include "scene.h"
#include "status_bar.h"

class MenuList;

class SettingsScene : public Scene {
   public:
    SettingsScene();
    // ~SettingsScene 必须在 .cc 实现:这里 unique_ptr<MenuList> 默认析构需要
    // 看到 MenuList 的完整定义,如果让编译器自动隐式 inline 析构,frame_scene.cc
    // 在 std::make_unique<SettingsScene>() 处会因 menu_list.h 没被 include 而
    // sizeof(MenuList) 失败。
    ~SettingsScene() override;

    const char* Name() const override {
        return "Settings";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    void SyncRender(SceneContext& ctx);

    lv_obj_t*                  root_ = nullptr;
    std::unique_ptr<StatusBar> status_bar_;
    std::unique_ptr<MenuList>  menu_;
    int                        saved_cursor_ = 0;  // 子页 pop 回来时恢复光标位置
};
