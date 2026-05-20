#pragma once

// 后台同步：POST /api/v1/devices/current/poll 后按 manifest 增量拉 frame image / audio。
// 状态/进度通过 EventBus 反馈：
//   - SyncStarted       每轮开始
//   - SyncFinished{ok}  每轮结束(含 304 noop)
//   - GroupReady{gid,content_count}  当 selected_group 内容就绪

#include <atomic>
#include <functional>
#include <string>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/semphr.h>

struct SyncDeps {
    std::function<bool(int* mv, int* pct)> read_battery;
    std::function<int()>                   read_rssi;
    std::function<std::string()>           current_group;
    std::function<int()>                   current_content_seq;
};

class SyncService {
   public:
    static SyncService& Get();

    void Start(SyncDeps deps);
    void Stop();

    // 立即触发一次 poll（设置页「立即同步」按钮用）
    void TriggerNow();

    // RTC timer 到期后触发：允许同步 + telemetry，并把新 manifest/data 拉下来。
    void TriggerWakeRefresh();

    // 设备主动 cycle 切组(scene 按键 callback 调)。
    // 内部置 BIT_CYCLE_NEXT/PREV,Loop 在唤醒时调 api::CycleGroup 然后立即 SyncOnce。
    void CycleNext();
    void CyclePrev();

    // 当前已就绪的 group_id(Scene::OnEnter 时读)
    std::string CurrentGroupId() const;

   private:
    SyncService() = default;
    static void TaskEntry(void* arg);
    void        Loop();
    int         NextIntervalSec() const;
    enum class SyncMode { kUserActive, kDynamicWake };
    void SyncOnce(SyncMode mode);
    void DoCycle(const std::string& direction);
    void SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag, bool& group_changed);
    void PostGroupReady(const std::string& gid, const std::string& name, int content_count, bool content_changed);
    std::string GetCurrentGroupLocked() const;
    void        SetCurrentGroupLocked(const std::string& gid);
    void        ClearCurrentGroupLocked();

    SyncDeps             deps_;
    std::atomic<bool>    running_{false};
    EventGroupHandle_t   event_group_         = nullptr;
    SemaphoreHandle_t    current_group_mutex_ = nullptr;
    mutable std::string  current_group_;
    // 跟踪 bound 翻转,只在变化时 emit kBound/kUnbound。
    std::atomic<bool> was_bound_{false};
    // 进入 unbound 状态的时刻,用于阶梯退避轮询间隔。
    std::atomic<int64_t> unbound_since_ms_{0};
};
