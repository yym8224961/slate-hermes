#include "sync/sync_service.h"

#include <esp_log.h>
#include <sdkconfig.h>

#include "bsp/board.h"
#include "events/event_bus.h"
#include "network/sntp.h"
#include "network/wifi.h"
#include "power/power_state.h"
#include "sync/sync_internal.h"
#include "utils/time_utils.h"

using sync_internal::kTag;

namespace {

api::Telemetry BuildTelemetry(const std::string& current_group, const std::string& wake_reason) {
    api::Telemetry tel;
    uint16_t       mv  = 0;
    uint8_t        pct = 0;
    if (Board::Get().ReadBattery(&mv, &pct)) {
        tel.battery_pct = pct;
        evt::PostBatteryUpdated(mv, pct, 0);
    }
    tel.rssi_dbm            = Wifi::Get().GetRssi();
    tel.fw_version          = CONFIG_APP_PROJECT_VER;
    tel.wake_reason         = wake_reason;
    tel.current_group       = current_group;
    tel.current_content_seq = power_state::CurrentFrameNeedsTimerWake() ? power_state::GetCurrentFrameSeq() : -1;
    if (tel.current_content_seq >= 0) {
        std::string      gid;
        std::string      manifest_etag;
        cache::FrameMeta meta;
        if (cache::ReadStateMeta(gid, manifest_etag) && !gid.empty() &&
            cache::ReadFrameMeta(gid, tel.current_content_seq, meta)) {
            tel.current_content_etag = meta.content_etag;
        }
    }
    tel.manifest_etag = cache::ReadCurrentManifestEtag();
    return tel;
}

}  // namespace

void SyncService::SyncOnce(SyncMode mode) {
    std::string telemetry_group = GetCurrentGroupLocked();
    if (mode == SyncMode::kBackgroundRefresh) {
        power_state::RestoreCurrentFrameScheduleFromCache();
        std::string gid, etag;
        if (cache::ReadStateMeta(gid, etag))
            telemetry_group = gid;
    }

    evt::PostSyncStarted(0);

    api::Telemetry tel = BuildTelemetry(telemetry_group, wake_reason_);
    if (ShouldStop())
        return;

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "Poll failed (offline?)");
        evt::PostSyncFinished(false, false, 0);
        return;
    }
    if (ShouldStop())
        return;
    sntp::ApplyServerTime(state.server_time);

    const BoundState prev_bound = was_bound_.load();
    const BoundState next_bound = state.bound ? BoundState::kBound : BoundState::kUnbound;
    if (next_bound != prev_bound) {
        if (state.bound) {
            evt::PostSimple(UiEventKind::kBound, 0);
        } else {
            ESP_LOGW(kTag, "Unbound");
            evt::PostUnbound(state.pair_code, 0);
        }
        was_bound_.store(next_bound);
        if (state.bound) {
            unbound_since_ms_.store(0);
        } else {
            unbound_since_ms_.store(time_utils::NowMs());
        }
    }

    if (!state.bound) {
        evt::PostBootStage(BootStage::kAwaitingPair, nullptr, state.pair_code.c_str(), 0);
    } else if (!state.has_group) {
        evt::PostBootStage(BootStage::kAwaitingGroup, nullptr, nullptr, 0);
    }

    bool group_changed = false;
    bool sync_ok       = true;
    if (mode == SyncMode::kBackgroundRefresh && state.has_group && state.has_current_content) {
        if (tel.manifest_etag != state.manifest_etag) {
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                            SyncReason::kBackgroundRefresh, group_changed);
        } else {
            sync_ok = SyncCurrentContent(state.group_id, state.current_content, group_changed);
            if (sync_ok && group_changed) {
                PostSyncedGroupReady(state.group_id, state.group_name, state.content_count,
                                     /*content_changed=*/true);
            }
        }
    } else if (mode == SyncMode::kBackgroundRefresh && state.has_group) {
        if (tel.manifest_etag != state.manifest_etag) {
            sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                            SyncReason::kBackgroundRefresh, group_changed);
        } else {
            ESP_LOGW(kTag, "Background refresh missing current_content; keep cached frame schedule");
            power_state::RestoreCurrentFrameScheduleFromCache();
            sync_ok = tel.current_content_seq < 0;
        }
    } else if (mode == SyncMode::kBackgroundRefresh) {
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    } else if (state.has_group) {
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                        SyncReason::kUserActive, group_changed);
    } else {
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    }

    evt::PostSyncFinished(sync_ok, group_changed, 0);
}

void SyncService::DoCycle(const std::string& direction) {
    evt::PostSyncStarted(0);

    api::DeviceState state;
    if (ShouldStop())
        return;
    if (!api::CycleGroup(direction, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "CycleGroup(%s) failed (offline?)", direction.c_str());
        evt::PostSyncFinished(false, false, 0);
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleFailed, "", "");
        return;
    }
    if (ShouldStop())
        return;

    bool group_changed = false;
    bool sync_ok       = true;
    if (state.has_group) {
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleTarget, state.group_id, state.group_name);
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                        SyncReason::kCycle, group_changed);
    } else {
        ClearCurrentGroupLocked();
        power_state::ClearCurrentFrame();
        sync_ok = cache::WriteStateMeta("", "");
    }

    evt::PostSyncFinished(sync_ok, group_changed, 0);
    if (!sync_ok)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleFailed, state.group_id, state.group_name);
}
