#pragma once

// Scene 抽象 + SceneContext。
// 所有可见 UI = 一个 Scene；多个 Scene 用 SceneStack 堆叠。栈底永远是 FrameScene。
// Scene 的所有方法仅由 ui_loop task 调用（OnEnter/OnExit/OnEvent）。

#include <lvgl.h>
#include <functional>

#include "charge_status.h"

class EpdSsd1683;
class AudioPlayer;
class SceneStack;

struct UiEvent;

struct SceneContext {
    EpdSsd1683*  epd   = nullptr;
    AudioPlayer* audio = nullptr;
    SceneStack*  stack = nullptr;

    // 数据访问通过依赖注入，Scene 不直接抓 Board / Wifi 单例。
    std::function<bool(int* mv, int* pct)>  read_battery;
    std::function<ChargeStatus::Snapshot()> read_charge;
    std::function<bool()>                   wifi_connected;
    std::function<int()>                    wifi_rssi;
};

class Scene {
   public:
    virtual ~Scene()                 = default;
    virtual const char* Name() const = 0;

    virtual void OnEnter(SceneContext& ctx) {
    }
    virtual void OnExit(SceneContext& ctx) {
    }
    virtual void OnEvent(SceneContext& ctx, const UiEvent& e) {
    }

    virtual lv_obj_t* Root() = 0;
};
