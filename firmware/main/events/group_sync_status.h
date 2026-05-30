#pragma once

#include <cstdint>

enum class GroupSyncStatusMode : uint8_t {
    kCycleTarget = 0,          // 已拿到主动切换目标
    kCycleCacheHit,            // 主动切换目标命中本地缓存
    kCycleDownloading,         // 正在下载主动切换目标
    kCurrentGroupUpdating,     // 后台刷新正在更新当前内容组
    kInitialGroupDownloading,  // 启动/普通同步正在下载目标内容组
    kTargetGroupSaving,        // 下载后正在保存目标内容组缓存
    kCurrentGroupSaving,       // 下载后正在保存当前内容组缓存
    kCycleFailed,              // 主动切换失败，保留当前内容组
};
