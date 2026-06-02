#pragma once

// 待办交互场景：查看、勾选、新建提醒事项。
// 支持从 Slate 后端拉取数据(capability URL)或本地离线模式。
//
// 导航：
//   ENTER 短按 = 勾选/取消(普通条目) 或 进入预设选择([+新建])
//   ENTER 长按 = 退出
//   UP/DOWN   = 移动光标

#include "scenes/core/scene.h"

#include <string>
#include <vector>

struct TodoItem {
    std::string text;
    bool        done = false;
    bool        is_new = false;  // "[+ 新建]" placeholder
};

// Preset reminder phrases
inline const std::vector<std::string> kTodoPresets = {
    "开会",
    "交报告/材料",
    "回电话",
    "买东西",
    "取快递",
    "约见面",
    "其他事项",
};

class TodoScene : public Scene {
   public:
    explicit TodoScene(SceneContext& ctx, std::string content_id);
    ~TodoScene() override;

    const char* Name() const override { return "todo"; }
    void      OnEnter(SceneContext& ctx) override;
    void      OnExit(SceneContext& ctx) override;
    void      OnEvent(SceneContext& ctx, const UiEvent& e) override;
    lv_obj_t* Root() override { return root_; }

   private:
    bool FetchTodoData();
    bool PushTodoState();
    void CreateLayout();
    void RenderList();
    void RenderPresetPicker();
    void MoveCursor(int delta);
    void ToggleCurrent();
    void SelectPreset(int index);
    void AddItem(const std::string& text);
    void DestroyItemControls();

    enum class Mode { kList, kPicker };
    Mode mode_ = Mode::kList;

    std::string           content_id_;
    std::vector<TodoItem> items_;
    int                   cursor_      = 0;
    int                   preset_idx_  = 0;
    bool                  dirty_       = false;
    bool                  offline_     = false;  // no backend sync

    lv_obj_t* root_         = nullptr;
    lv_obj_t* header_label_ = nullptr;
    lv_obj_t* hint_label_   = nullptr;
    lv_obj_t* picker_label_ = nullptr;

    struct ItemControl {
        lv_obj_t* label = nullptr;
    };
    std::vector<ItemControl> item_ctrls_;
    std::vector<ItemControl> picker_ctrls_;
    static constexpr int     kMaxVisibleItems = 7;
    static constexpr int     kItemYStart      = 50;
    static constexpr int     kItemHeight      = 18;
    static constexpr int     kPickerYStart    = 56;
};
