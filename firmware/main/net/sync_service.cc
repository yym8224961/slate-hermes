#include "sync_service.h"

#include <cstring>
#include <ctime>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>
#include <sdkconfig.h>

#include "../app/event_bus.h"
#include "../app/power_state.h"
#include "../storage/cache.h"
#include "api_client.h"
#include "poll_interval_store.h"

namespace {
constexpr char kTag[]            = "Sync";
constexpr int  BIT_TRIGGER       = BIT0;
constexpr int  BIT_STOP          = BIT1;
constexpr int  BIT_CYCLE_NEXT    = BIT2;
constexpr int  BIT_CYCLE_PREV    = BIT3;

// unbound 期阶梯退避轮询: 用户在 Web 端输码后快速屏切「等待相册」。
// bound 后由 SleepManager 允许 deep sleep,设备活跃时 poll 间隔由用户偏好决定。
constexpr int kUnboundFastPollSec    = 10;   // 前 10 分钟
constexpr int kUnboundMediumPollSec  = 30;   // 10-30 分钟
constexpr int kUnboundSlowPollSec    = 60;   // 30 分钟-2 小时
constexpr int64_t kUnboundFastMs     = 10LL * 60 * 1000;
constexpr int64_t kUnboundMediumMs   = 30LL * 60 * 1000;
}

SyncService& SyncService::Get() {
    static SyncService s;
    return s;
}

void SyncService::TaskEntry(void* arg) {
    static_cast<SyncService*>(arg)->Loop();
    vTaskDelete(nullptr);
}

void SyncService::Start(SyncDeps deps) {
    if (running_.load()) return;
    deps_ = std::move(deps);
    if (!event_group_) {
        event_group_ = xEventGroupCreate();
        if (!event_group_) {
            ESP_LOGE(kTag, "Failed to create event group");
            return;
        }
    }
    running_.store(true);
    last_user_active_ms_.store(esp_timer_get_time() / 1000);
    xTaskCreatePinnedToCore(&TaskEntry, "slate_sync", 10 * 1024, this, 4, nullptr, 0);
    ESP_LOGI(kTag, "Sync service started");
}

void SyncService::Stop() {
    running_.store(false);
    if (event_group_) {
        xEventGroupSetBits(event_group_, BIT_STOP);
    }
}

void SyncService::TriggerNow() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_TRIGGER);
}

void SyncService::MarkUserActive() {
    last_user_active_ms_.store(esp_timer_get_time() / 1000);
}

void SyncService::CycleNext() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_CYCLE_NEXT);
}

void SyncService::CyclePrev() {
    if (event_group_) xEventGroupSetBits(event_group_, BIT_CYCLE_PREV);
}

std::string SyncService::CurrentGroupId() const {
    return current_group_;
}

int SyncService::NextIntervalSec() const {
    if (was_bound_.load()) return poll::Get();
    const int64_t elapsed = (esp_timer_get_time() / 1000) - unbound_since_ms_.load();
    if (elapsed < kUnboundFastMs)   return kUnboundFastPollSec;
    if (elapsed < kUnboundMediumMs) return kUnboundMediumPollSec;
    return kUnboundSlowPollSec;
}

void SyncService::PostGroupReady(const std::string& gid, const std::string& name,
                                 int content_count, bool content_changed) {
    UiEvent e{};
    e.kind = UiEventKind::kGroupReady;
    std::strncpy(e.u.group.gid, gid.c_str(), sizeof(e.u.group.gid) - 1);
    e.u.group.gid[sizeof(e.u.group.gid) - 1] = '\0';
    std::strncpy(e.u.group.name, name.c_str(), sizeof(e.u.group.name) - 1);
    e.u.group.name[sizeof(e.u.group.name) - 1] = '\0';
    e.u.group.content_count   = content_count;
    e.u.group.content_changed = content_changed;
    evt::Post(e);
}

// 把 telemetry 准备好。顺便 emit kBatteryUpdated 让 status_bar / SleepManager 同步;
// 系统中只有这里周期性读电量,没必要单独再起一个 battery tick。
static api::Telemetry BuildTelemetry(const SyncDeps& deps, const std::string& current_group) {
    api::Telemetry tel;
    if (deps.read_battery) {
        int mv = 0, pct = 0;
        if (deps.read_battery(&mv, &pct)) {
            tel.battery_pct = pct;
            UiEvent e{};
            e.kind          = UiEventKind::kBatteryUpdated;
            e.u.battery.mv  = mv;
            e.u.battery.pct = pct;
            evt::Post(e, 0);
        }
    }
    if (deps.read_rssi) tel.rssi_dbm = deps.read_rssi();
    tel.fw_version        = CONFIG_APP_PROJECT_VER;
    tel.current_group     = current_group;
    if (deps.current_content_seq) tel.current_content_seq = deps.current_content_seq();
    return tel;
}

// 拉某 group 的 manifest 并把缺的 frame 落盘。group_changed 表示是否真的有「内容更新」。
void SyncService::SyncManifestAndFrames(const std::string& gid, const std::string& expected_etag,
                                        bool& group_changed) {
    group_changed = false;
    if (gid.empty()) return;

    std::string cached_group_id, cached_etag;
    cache::ReadStateMeta(cached_group_id, cached_etag);

    bool need = (gid != cached_group_id) || (expected_etag != cached_etag);
    if (!need) {
        if (current_group_ != gid) {
            current_group_ = gid;
            int content_count = 0;
            cache::ReadManifestContentCount(gid, content_count);
            // 内容没变,只是 splash → frame_scene 首次切换需要 hint;不刷屏。
            // name 留空，下一轮 manifest 拉成功后会用真实名字补一次。
            PostGroupReady(gid, "", content_count, /*content_changed=*/false);
        }
        return;
    }

    api::Manifest mf;
    bool          not_modified = false;
    std::string   if_none_match;
    if (gid == cached_group_id && !cached_etag.empty()) {
        if_none_match = cached_etag;
    }
    if (!api::GetManifest(gid, if_none_match, mf, not_modified)) {
        ESP_LOGW(kTag, "GetManifest failed");
        return;
    }
    if (not_modified) {
        ESP_LOGI(kTag, "Manifest 304 not modified");
        const bool first_seen = (current_group_ != gid);
        current_group_ = gid;
        if (first_seen) {
            int content_count = 0;
            cache::ReadManifestContentCount(gid, content_count);
            // 304 → server 没下发新 manifest，没有 group_name。留空让 UI 兜底。
            PostGroupReady(gid, "", content_count, /*content_changed=*/false);
        }
        return;
    }

    int old_content_count = 0;
    cache::ReadManifestContentCount(gid, old_content_count);

    const int total = static_cast<int>(mf.contents.size());
    int       done  = 0;
    // 防日志噪音：同一 gid 的协议不匹配只 warn 一次/进程，避免每 tick 反复刷屏。
    static std::string s_warned_gid;
    for (auto& f : mf.contents) {
        // 协议 v3：拉 image/audio 走 /contents/:contentId/image|audio。
        // 本地缓存仍按 (gid, seq) 维度（FrameScene 按键翻页用 seq 索引），
        // 仅 HTTP URL 切到 content_id。
        if (f.content_id.empty()) {
            if (s_warned_gid != gid) {
                ESP_LOGW(kTag,
                         "Frame seq=%d 缺 content_id（gid=%s），跳过下载",
                         f.seq, gid.c_str());
                s_warned_gid = gid;
            }
            ++done;
            continue;
        }
        if (!cache::FrameImageExists(gid, f.seq, f.image_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadContentImage(f.content_id, "", buf, nm)) {
                cache::WriteFrameImage(gid, f.seq, buf, f.image_etag);
                ESP_LOGI(kTag, "Frame %d image cached (%u B)", f.seq, (unsigned)buf.size());
            }
        }
        if (f.audio_etag.empty()) {
            cache::DeleteFrameAudio(gid, f.seq);
        } else if (!cache::FrameAudioExists(gid, f.seq, f.audio_etag)) {
            std::vector<uint8_t> buf;
            bool                 nm = false;
            if (api::DownloadContentAudio(f.content_id, "", buf, nm)) {
                cache::WriteFrameAudio(gid, f.seq, buf, f.audio_etag);
            }
        }
        // 一次性写 caption + ttl 到 .meta（减一个 LittleFS inode）。
        // ttl 来自协议 v3 的 next_wake_sec，让 FrameScene LoadFrame 后写入
        // power_state，设备睡前算精确 RTC wake 时刻。
        cache::FrameMeta fm;
        fm.caption = f.caption;
        fm.ttl_sec = static_cast<uint32_t>(f.next_wake_sec);
        cache::WriteFrameMeta(gid, f.seq, fm);
        ++done;
        // 帧级进度,Scene 自己决定显示与否(BootSplash + FrameScene 关心,
        // SettingsScene 等忽略)。clamp 到 0xFF 避免极端 group 溢出。
        UiEvent e{};
        e.kind            = UiEventKind::kSyncProgress;
        e.u.progress.current = static_cast<uint8_t>(done > 255 ? 255 : done);
        e.u.progress.total   = static_cast<uint8_t>(total > 255 ? 255 : total);
        evt::Post(e, 0);
    }
    for (int idx = total; idx < old_content_count; ++idx) {
        cache::DeleteFrameFiles(gid, idx);
    }
    cache::WriteManifest(gid, mf.group_etag, mf.contents.size());
    cache::WriteStateMeta(gid, mf.group_etag);
    current_group_  = gid;
    group_changed   = true;
    // 真有内容变化(新增/修改/删除帧),让 FrameScene 重读当前帧并触发 EPD 刷新。
    PostGroupReady(gid, mf.group_name, static_cast<int>(mf.contents.size()),
                   /*content_changed=*/true);
}

void SyncService::SyncOnce() {
    {
        UiEvent e{};
        e.kind = UiEventKind::kSyncStarted;
        evt::Post(e, 0);
    }

    api::Telemetry tel = BuildTelemetry(deps_, current_group_);

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        ESP_LOGW(kTag, "Poll failed (offline?)");
        UiEvent e{};
        e.kind = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }
    // 成功上报 telemetry → 记 UNIX epoch 到 RTC RAM。
    // time(NULL) 在 SNTP 同步后是真实 wall clock，跨 deep sleep 连续；
    // power_state 内部会检测 SNTP 未同步并拒绝写入。
    power_state::SetLastTelemetryAt(static_cast<uint32_t>(time(nullptr)));

    // 1. bound 翻转:发独立事件让 splash / frame_scene 都能响应。
    bool prev_bound = was_bound_.load();
    if (state.bound != prev_bound) {
        UiEvent e{};
        if (state.bound) {
            e.kind = UiEventKind::kBound;
            ESP_LOGI(kTag, "Bound");
        } else {
            e.kind = UiEventKind::kUnbound;
            std::strncpy(e.u.unbound.pair_code, state.pair_code.c_str(),
                         sizeof(e.u.unbound.pair_code) - 1);
            e.u.unbound.pair_code[sizeof(e.u.unbound.pair_code) - 1] = '\0';
            ESP_LOGW(kTag, "Unbound: pair_code=%s", state.pair_code.c_str());
        }
        evt::Post(e, 0);
        was_bound_.store(state.bound);
        if (state.bound) {
            unbound_since_ms_.store(0);
        } else {
            unbound_since_ms_.store(esp_timer_get_time() / 1000);
        }
    }

    // 2. 当前态推 splash:让重启场景的 splash 也能直接拿到正确文案,无需依赖翻转。
    //    (启动时 splash 会先看 kAwaitingPair/kAwaitingGroup 切到正确文案;
    //     SyncManifestAndFrames 后续 emit kGroupReady 会 RequestReplace 到 FrameScene。)
    UiEvent stage_evt{};
    stage_evt.kind = UiEventKind::kBootStage;
    stage_evt.u.boot_stage.ssid[0] = '\0';
    stage_evt.u.boot_stage.pair_code[0] = '\0';
    if (!state.bound) {
        stage_evt.u.boot_stage.stage = BootStage::kAwaitingPair;
        std::strncpy(stage_evt.u.boot_stage.pair_code, state.pair_code.c_str(),
                     sizeof(stage_evt.u.boot_stage.pair_code) - 1);
        evt::Post(stage_evt, 0);
    } else if (!state.has_group) {
        stage_evt.u.boot_stage.stage = BootStage::kAwaitingGroup;
        evt::Post(stage_evt, 0);
    }
    // bound + has_group 不发 boot_stage,SyncManifestAndFrames 走 kGroupReady。

    bool group_changed = false;
    if (state.has_group) {
        SyncManifestAndFrames(state.group_id, state.group_etag, group_changed);
    } else {
        // 没选组:清掉 current_group_(scene 等下一次 GroupReady)
        current_group_.clear();
    }

    UiEvent e{};
    e.kind = UiEventKind::kSyncFinished;
    e.u.sync.ok            = true;
    e.u.sync.group_changed = group_changed;
    evt::Post(e, 0);
}

void SyncService::DoCycle(const std::string& direction) {
    {
        UiEvent e{};
        e.kind = UiEventKind::kSyncStarted;
        evt::Post(e, 0);
    }

    api::DeviceState state;
    if (!api::CycleGroup(direction, state)) {
        ESP_LOGW(kTag, "CycleGroup(%s) failed (offline?)", direction.c_str());
        UiEvent e{};
        e.kind = UiEventKind::kSyncFinished;
        e.u.sync.ok            = false;
        e.u.sync.group_changed = false;
        evt::Post(e, 0);
        return;
    }

    bool group_changed = false;
    if (state.has_group) {
        ESP_LOGI(kTag, "Cycled %s -> %s (pos %d/%d)", direction.c_str(),
                 state.group_id.c_str(), state.position_current, state.position_total);
        SyncManifestAndFrames(state.group_id, state.group_etag, group_changed);
    } else {
        ESP_LOGI(kTag, "Cycle %s: no groups available", direction.c_str());
        current_group_.clear();
    }

    UiEvent e{};
    e.kind = UiEventKind::kSyncFinished;
    e.u.sync.ok            = true;
    e.u.sync.group_changed = group_changed;
    evt::Post(e, 0);
}

void SyncService::Loop() {
    SyncOnce();

    while (running_.load()) {
        const int interval_s = NextIntervalSec();
        const EventBits_t bits = xEventGroupWaitBits(
            event_group_,
            BIT_TRIGGER | BIT_STOP | BIT_CYCLE_NEXT | BIT_CYCLE_PREV,
            pdTRUE,
            pdFALSE,
            pdMS_TO_TICKS(interval_s * 1000));
        if (bits & BIT_STOP) break;
        if (!running_.load()) break;

        // cycle 优先于普通轮询:cycle 后会自然把新 group 的 manifest 拉下来,
        // 不需要再 SyncOnce 一次。
        if (bits & BIT_CYCLE_NEXT) {
            DoCycle("next");
        } else if (bits & BIT_CYCLE_PREV) {
            DoCycle("prev");
        } else {
            SyncOnce();
        }
    }
}
