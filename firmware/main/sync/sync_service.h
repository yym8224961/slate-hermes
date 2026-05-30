#pragma once

// 后台同步：POST /api/v1/devices/current/poll 后按 manifest 增量拉 frame image / audio。
// 状态/进度通过 EventBus 反馈：
//   - SyncStarted       每轮开始
//   - SyncFinished{ok}  每轮结束(含 304 noop)
//   - kSyncedGroupReady{gid,content_count}  当 selected_group 内容就绪

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "storage/cache/cache.h"
#include "sync/api_client.h"

class SyncService {
   public:
    static SyncService& Get();

    enum class InitialSync {
        kNone,
        kUserActive,
        kBackgroundRefresh,
    };

    void Start(std::string wake_reason, InitialSync initial_sync = InitialSync::kNone);
    void Stop();

    // 主动触发一次前台 poll。用于后台刷新被充电/解绑宽限打断后转入 active 模式。
    void RequestUserActiveSync();

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
    enum class SyncMode { kUserActive, kBackgroundRefresh };
    enum class SyncReason { kUserActive, kBackgroundRefresh, kCycle };
    void SyncOnce(SyncMode mode);
    void Trigger(SyncMode mode);
    void DoCycle(const std::string& direction);
    bool ShouldStop() const;
    bool SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag, const std::string& group_name,
                               int expected_content_count, SyncReason reason, bool& group_changed);
    bool SyncCurrentContent(const std::string& gid, const api::ContentMeta& content, bool& changed);
    bool HandleCachedManifestHit(const std::string& gid, const std::string& expected_etag,
                                 const std::string& status_name, int content_count, const std::string& previous_current,
                                 const std::string& selected_group_id, SyncReason reason);
    bool HandleNotModifiedManifest(const std::string& gid, const cache::ManifestMeta& cached_meta,
                                   const std::string& status_name, int expected_content_count,
                                   const std::string& previous_current, const std::string& selected_group_id,
                                   SyncReason reason);
    bool DownloadFramesToStage(const std::string& gid, const api::Manifest& manifest, const std::string& status_name,
                               const std::string& previous_current, const std::string& selected_group_id,
                               SyncReason reason, int& total_updates);
    bool CommitStagedFrames(const std::string& gid, const api::Manifest& manifest, const std::string& group_name,
                            const std::string& selected_group_id, bool current_group_update, SyncReason reason,
                            int total_updates, int old_content_count);
    void PostSyncedGroupReady(const std::string& gid, const std::string& name, int content_count, bool content_changed);
    std::string GetCurrentGroupLocked() const;
    void        SetCurrentGroupLocked(const std::string& gid);
    void        ClearCurrentGroupLocked();

    std::atomic<bool>    running_{false};
    mutable std::mutex   task_mutex_;
    mutable std::mutex   current_group_mutex_;
    EventGroupHandle_t   event_group_ = nullptr;
    SemaphoreHandle_t    exit_sem_    = nullptr;
    TaskHandle_t         task_handle_ = nullptr;
    mutable std::string  current_group_;
    std::string          wake_reason_;
    std::vector<uint8_t> download_buf_;
    enum class BoundState : uint8_t { kUnknown, kBound, kUnbound };
    // 跟踪 bound 翻转。Unknown 初始态保证首轮 unbound 也会 emit kUnbound。
    std::atomic<BoundState> was_bound_{BoundState::kUnknown};
    // 进入 unbound 状态的时刻,用于阶梯退避轮询间隔。
    std::atomic<int64_t> unbound_since_ms_{0};
};
