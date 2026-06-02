#include "storage/cache/cache_staging.h"

#include <esp_log.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>

namespace cache::staging {
namespace {

constexpr char kTag[] = "cache_stage";

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RenameReplace(const std::string& from, const std::string& to) {
    if (rename(from.c_str(), to.c_str()) == 0)
        return true;
    ESP_LOGW(kTag, "rename failed from=%s to=%s errno=%d", from.c_str(), to.c_str(), errno);
    return false;
}

bool RemoveIfExists(const std::string& path) {
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "unlink failed path=%s errno=%d", path.c_str(), errno);
    return false;
}

void RollbackSwaps(std::vector<Swap>& swaps) {
    for (auto it = swaps.rbegin(); it != swaps.rend(); ++it) {
        if (it->installed) {
            if (rename(it->target.c_str(), it->staged.c_str()) != 0 && errno != ENOENT) {
                ESP_LOGW(kTag, "rollback move failed from=%s to=%s errno=%d", it->target.c_str(), it->staged.c_str(),
                         errno);
                RemoveIfExists(it->target);
            }
            it->installed = false;
        }
        if (it->had_target) {
            if (rename(it->backup.c_str(), it->target.c_str()) != 0) {
                ESP_LOGE(kTag, "rollback restore failed from=%s to=%s errno=%d", it->backup.c_str(), it->target.c_str(),
                         errno);
            }
            it->had_target = false;
        } else {
            RemoveIfExists(it->backup);
        }
    }
}

}  // namespace

bool CommitSwaps(std::vector<Swap>& swaps) {
    for (auto& swap : swaps) {
        if (!RemoveIfExists(swap.backup)) {
            RollbackSwaps(swaps);
            return false;
        }
        if (PathExists(swap.target)) {
            if (!RenameReplace(swap.target, swap.backup)) {
                RollbackSwaps(swaps);
                return false;
            }
            swap.had_target = true;
        }
        if (!RenameReplace(swap.staged, swap.target)) {
            if (swap.had_target) {
                if (RenameReplace(swap.backup, swap.target)) {
                    swap.had_target = false;
                } else {
                    ESP_LOGE(kTag, "stage restore failed target=%s", swap.target.c_str());
                }
            }
            RollbackSwaps(swaps);
            return false;
        }
        swap.installed = true;
    }
    for (auto& swap : swaps) {
        if (swap.had_target)
            RemoveIfExists(swap.backup);
        swap.had_target = false;
        swap.installed  = false;
    }
    return true;
}

}  // namespace cache::staging
