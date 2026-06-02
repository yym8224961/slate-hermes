#pragma once

// 待办交互场景：本地 LVGL 渲染待办列表，支持上下键导航、确认键勾选/取消。
// 长按确认键退出并 POST 状态变更回 Slate 后端。
//
// 数据来源：GET /api/v1/contents/{todo_content_id}/data (capability URL)
// 状态回写：POST /api/v1/contents/{todo_content_id}/data

#include "scenes/core/scene.h"

#include <functional>
#include <string>
#include <vector>

struct TodoItem {
    std::string text;
    bool        done = false;
};

class TodoScene : public Scene {
   public:
    explicit TodoScene(SceneContext& ctx, std::string content_id);
    ~TodoScene() override;

    const char* Name() const override {
        return "todo";
    }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override {
        return root_;
    }

   private:
    bool FetchTodoData();
    bool PushTodoState();
    void CreateLayout();
    void RenderList();
    void MoveCursor(int delta);
    void ToggleCurrent();
    void DestroyItemControls();

    std::string              content_id_;    // capability URL 的 contentId
    std::vector<TodoItem>    items_;
    int                      cursor_ = 0;
    bool                     dirty_  = false;

    lv_obj_t* root_        = nullptr;
    lv_obj_t* header_label_ = nullptr;
    lv_obj_t* hint_label_   = nullptr;

    struct ItemControl {
        lv_obj_t* label = nullptr;
    };
    std::vector<ItemControl> item_ctrls_;
    static constexpr int     kMaxVisibleItems = 8;
    static constexpr int     kItemYStart      = 56;
    static constexpr int     kItemHeight      = 18;
};
