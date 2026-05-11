#pragma once

// 顶层 App。把所有子系统按依赖顺序串起来：
//   Storage → Board → Audio → EventBus → SceneStack → ui_loop task →
//   Inputs(按键/充电→EventBus) → TimeTick → Network → SleepManager → PM
//
// Run() 等同 vTaskDelete(NULL)：把 main task 的 8 KB 栈让出来，
// 由各后台 task（ui_loop / sync / charge_tick / audio / epd_refresh）继续跑。

#include <memory>

#include "event_bus.h"
#include "scene_stack.h"
#include "sleep_manager.h"
#include "time_tick.h"

class CaptivePortal;

class App {
   public:
    App();
    ~App();
    void Init();
    void Run();

   private:
    void InitStorage();
    void InitDevices();
    void InitEventBus();
    void InitSceneStack();
    void StartUiLoop();
    void AttachInputs();
    void StartTimeTick();
    void InitNetwork();
    void StartSleep();
    void FinalizePm();

    void StartPortal();

    static void UiLoopEntry(void* arg);
    void        UiLoopTask();

    SceneStack                     scene_stack_;
    SleepManager                   sleep_mgr_;
    TimeTick                       time_tick_;
    std::unique_ptr<CaptivePortal> portal_;
    bool                           ui_loop_running_ = false;
};
