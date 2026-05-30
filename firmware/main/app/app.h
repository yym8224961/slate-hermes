#pragma once

// 顶层 App。把所有子系统按依赖顺序串起来：
//   Storage → Board → Audio → EventBus → SceneStack → ui_loop task →
//   Inputs(按键/充电→EventBus) → TimeTick → Network → SleepManager → PM
//
// Run() 等同 vTaskDelete(NULL)：把 main task 的 8 KB 栈让出来，
// 由各后台 task（ui_loop / sync / charge_tick / audio / epd_refresh）继续跑。

#include <atomic>
#include <memory>
#include <string>

#include "boot_mode.h"
#include "combo_key.h"
#include "cred_store.h"
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
    bool InitWifiAndSync(cred::Credentials& creds);
    bool ReadBattery(int* mv, int* pct);
    void StartSleep();
    void FinalizePm();

    void StartPortal();
    void PostWakeupKeyEvent(uint64_t ext1_mask);
    void PromoteToFrameSceneFromCache();
    bool HandleSecretInvalid(const UiEvent& e);
    bool HandleBackgroundRefreshDone(const UiEvent& e);
    bool HandleXiaozhiChannelClosed(const UiEvent& e);
    bool HandleInitialGroupReady(const UiEvent& e);
    bool HandleEnterDoubleClick(const UiEvent& e);

    static void UiLoopEntry(void* arg);
    void        UiLoopTask();

    SceneStack                     scene_stack_;
    SleepManager                   sleep_mgr_;
    TimeTick                       time_tick_;
    ComboKeyController             combo_key_;
    std::unique_ptr<CaptivePortal> portal_;
    std::atomic<bool>              ui_loop_running_{false};
    boot_mode::Decision            decision_;
};
