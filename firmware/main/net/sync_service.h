#pragma once

// 后台轮询：周期 POST /api/v1/me/poll(同步上报 telemetry + 拿 state),
// 增量拉缺失的 frame.img + .pcm 到 LittleFS。
// 状态/进度通过 EventBus 反馈：
//   - SyncStarted       每轮开始
//   - SyncFinished{ok}  每轮结束(含 304 noop)
//   - GroupReady{gid,frame_count,default_seq}  当 selected_group 内容就绪

#include <atomic>
#include <functional>
#include <string>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#include "../hal/charge_status.h"

struct SyncDeps {
    std::function<bool(int* mv, int* pct)> read_battery;
    std::function<int()>                   read_rssi;
    std::function<ChargeStatus::Snapshot()> read_charge;
    std::function<int()>                   current_frame_seq;
};

class SyncService {
   public:
    static SyncService& Get();

    void Start(SyncDeps deps);
    void Stop();

    // 立即触发一次 poll（设置页「立即同步」按钮用）
    void TriggerNow();

    // 通知「用户活动」（按键 / 切 frame）— 用于自适应轮询间隔。
    void MarkUserActive();

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
    void        SyncOnce();
    void        DoCycle(const std::string& direction);
    void        SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag,
                                      bool& group_changed);
    void        PostGroupReady(const std::string& gid, int frame_count, int default_seq);

    SyncDeps              deps_;
    std::atomic<bool>     running_{false};
    EventGroupHandle_t    event_group_ = nullptr;
    mutable std::string   current_group_;
    std::atomic<int64_t>  last_user_active_ms_{0};
    // 后端 state.poll_interval_s 决定的下一轮等待间隔(splash 期 5s / bound 后 30s)。
    std::atomic<int>      last_poll_interval_s_{30};
    // 跟踪 bound 翻转,只在变化时 emit kBound/kUnbound。
    std::atomic<bool>     was_bound_{false};
};
