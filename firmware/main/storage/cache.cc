#include "cache.h"

#include <cJSON.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <dirent.h>
#include <unistd.h>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "config.h"
#include "frame_view.h"
#include "scoped_mutex_lock.h"

namespace {
constexpr char kTag[]           = "Cache";
constexpr char kRoot[]          = "/littlefs";
constexpr long kMaxReadBytes    = AUDIO_MAX_PCM_BYTES;
constexpr long kFrameImageBytes = FrameView::kRawBytes;
}  // namespace

namespace {

bool DirEnsure(const std::string& dir) {
    struct stat st;
    if (stat(dir.c_str(), &st) == 0 && S_ISDIR(st.st_mode))
        return true;
    if (mkdir(dir.c_str(), 0775) == 0)
        return true;
    if (errno == EEXIST)
        return true;
    ESP_LOGW(kTag, "Mkdir %s failed: %d", dir.c_str(), errno);
    return false;
}

// 原子写:写到 path.tmp 然后 rename。LittleFS rename 是原子的,
// 中途断电只会留下 .tmp(下次启动时无人 fopen 会自然忽略)或保持原文件不变。
bool WriteAll(const std::string& path, const void* data, size_t len) {
    const std::string tmp = path + ".tmp";
    FILE*             f   = fopen(tmp.c_str(), "wb");
    if (!f) {
        ESP_LOGW(kTag, "Open w %s failed: %d", tmp.c_str(), errno);
        return false;
    }
    size_t w    = fwrite(data, 1, len, f);
    int    cret = fclose(f);  // flush 失败(磁盘满)在这里才暴露
    if (w != len || cret != 0) {
        ESP_LOGW(kTag, "Write %s short/flush failed (w=%u/%u close=%d)", tmp.c_str(), (unsigned)w, (unsigned)len, cret);
        unlink(tmp.c_str());
        return false;
    }
    if (rename(tmp.c_str(), path.c_str()) != 0) {
        ESP_LOGW(kTag, "Rename %s -> %s failed: %d", tmp.c_str(), path.c_str(), errno);
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

bool ReadAll(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f)
        return false;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return false;
    }
    long len = ftell(f);
    if (len < 0) {
        ESP_LOGW(kTag, "Ftell %s failed: %d", path.c_str(), errno);
        fclose(f);
        return false;
    }
    if (len > kMaxReadBytes) {
        ESP_LOGW(kTag, "Read %s refused: %ld B exceeds limit", path.c_str(), len);
        fclose(f);
        return false;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return false;
    }
    out.resize(static_cast<size_t>(len));
    size_t r = fread(out.data(), 1, static_cast<size_t>(len), f);
    fclose(f);
    return r == static_cast<size_t>(len);
}

std::string SafePathComponent(const std::string& raw) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(raw.size() * 3);
    for (unsigned char ch : raw) {
        if (std::isalnum(ch) || ch == '-' || ch == '_')
            out.push_back(static_cast<char>(ch));
        else {
            out.push_back('%');
            out.push_back(kHex[ch >> 4]);
            out.push_back(kHex[ch & 0x0F]);
        }
    }
    return out.empty() ? "_" : out;
}

std::string GroupDir(const std::string& gid) {
    return std::string(kRoot) + "/groups/" + SafePathComponent(gid);
}
std::string StatePath() {
    return std::string(kRoot) + "/state.json";
}

SemaphoreHandle_t StateMutex() {
    static StaticSemaphore_t s_mutex_buf;
    static SemaphoreHandle_t s_mutex = xSemaphoreCreateMutexStatic(&s_mutex_buf);
    return s_mutex;
}

struct StateJson {
    cJSON* root = nullptr;

    StateJson() = default;
    ~StateJson() {
        if (root)
            cJSON_Delete(root);
    }

    StateJson(const StateJson&)            = delete;
    StateJson& operator=(const StateJson&) = delete;
    StateJson(StateJson&& other) noexcept : root(other.root) {
        other.root = nullptr;
    }
    StateJson& operator=(StateJson&& other) noexcept {
        if (this != &other) {
            if (root)
                cJSON_Delete(root);
            root       = other.root;
            other.root = nullptr;
        }
        return *this;
    }
};

StateJson ReadStateJsonUnlocked() {
    StateJson state;
    std::vector<uint8_t> buf;
    if (!ReadAll(StatePath(), buf))
        return state;
    state.root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    return state;
}

std::string JsonStringField(cJSON* root, const char* key) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsString(value) && value->valuestring ? value->valuestring : "";
}

int JsonNonNegativeIntField(cJSON* root, const char* key, int default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (cJSON_IsNumber(value) && value->valueint >= 0)
        return value->valueint;
    return default_value;
}

bool WriteStateJsonUnlocked(const std::string& selected_group_id, const std::string& etag, int current_frame_seq) {
    if (current_frame_seq < 0)
        current_frame_seq = 0;

    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "selected_group_id", selected_group_id.c_str());
    cJSON_AddStringToObject(root, "last_etag", etag.c_str());
    cJSON_AddNumberToObject(root, "current_frame_seq", current_frame_seq);
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(StatePath(), s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}
std::string FramesDir(const std::string& gid) {
    return GroupDir(gid) + "/frames";
}
std::string StageDir(const std::string& gid) {
    return GroupDir(gid) + "/stage";
}
std::string ImagePath(const std::string& gid, int idx) {
    return FramesDir(gid) + "/" + std::to_string(idx) + ".img";
}
std::string AudioPath(const std::string& gid, int idx) {
    return FramesDir(gid) + "/" + std::to_string(idx) + ".pcm";
}
std::string EtagPath(const std::string& gid, int idx, const char* ext) {
    return FramesDir(gid) + "/" + std::to_string(idx) + "." + ext + ".etag";
}
std::string StageImagePath(const std::string& gid, int idx) {
    return StageDir(gid) + "/" + std::to_string(idx) + ".img";
}
std::string StageAudioPath(const std::string& gid, int idx) {
    return StageDir(gid) + "/" + std::to_string(idx) + ".pcm";
}
std::string StageEtagPath(const std::string& gid, int idx, const char* ext) {
    return StageDir(gid) + "/" + std::to_string(idx) + "." + ext + ".etag";
}

bool MatchEtag(const std::string& path, const std::string& expected) {
    if (expected.empty())
        return false;
    FILE* f = fopen(path.c_str(), "rb");
    if (!f)
        return false;
    char   buf[256];
    size_t n        = fread(buf, 1, sizeof(buf), f);
    bool   read_err = ferror(f) != 0;
    bool   too_long = false;
    if (!read_err && n == sizeof(buf)) {
        too_long = fgetc(f) != EOF;
    }
    fclose(f);
    if (read_err || too_long)
        return false;
    return expected.size() == n && std::memcmp(expected.data(), buf, n) == 0;
}

bool WriteEtag(const std::string& path, const std::string& etag) {
    return WriteAll(path, etag.data(), etag.size());
}

bool RemoveTree(const std::string& path) {
    DIR* dir = opendir(path.c_str());
    if (!dir) {
        return errno == ENOENT;
    }
    bool ok = true;
    while (struct dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string child = path + "/" + ent->d_name;
        struct stat       st;
        if (stat(child.c_str(), &st) != 0) {
            ok = false;
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            ok = RemoveTree(child) && ok;
        } else if (unlink(child.c_str()) != 0 && errno != ENOENT) {
            ESP_LOGW(kTag, "Unlink %s failed: %d", child.c_str(), errno);
            ok = false;
        }
    }
    closedir(dir);
    if (rmdir(path.c_str()) != 0 && errno != ENOENT) {
        ESP_LOGW(kTag, "Rmdir %s failed: %d", path.c_str(), errno);
        ok = false;
    }
    return ok;
}

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RenameReplace(const std::string& from, const std::string& to) {
    if (rename(from.c_str(), to.c_str()) == 0)
        return true;
    ESP_LOGW(kTag, "Rename %s -> %s failed: %d", from.c_str(), to.c_str(), errno);
    return false;
}

bool RemoveIfExists(const std::string& path) {
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "Unlink %s failed: %d", path.c_str(), errno);
    return false;
}

struct StagedSwap {
    std::string staged;
    std::string target;
    std::string backup;
    bool        had_target = false;
    bool        installed  = false;
};

void RollbackStagedSwaps(std::vector<StagedSwap>& swaps) {
    for (auto it = swaps.rbegin(); it != swaps.rend(); ++it) {
        if (it->installed) {
            if (rename(it->target.c_str(), it->staged.c_str()) != 0 && errno != ENOENT) {
                ESP_LOGW(kTag, "Rollback move %s -> %s failed: %d", it->target.c_str(), it->staged.c_str(), errno);
                RemoveIfExists(it->target);
            }
            it->installed = false;
        }
        if (it->had_target) {
            if (rename(it->backup.c_str(), it->target.c_str()) != 0) {
                ESP_LOGE(kTag, "Rollback restore %s -> %s failed: %d", it->backup.c_str(), it->target.c_str(), errno);
            }
            it->had_target = false;
        } else {
            RemoveIfExists(it->backup);
        }
    }
}

bool CommitStagedSwaps(std::vector<StagedSwap>& swaps) {
    for (auto& swap : swaps) {
        if (!RemoveIfExists(swap.backup)) {
            RollbackStagedSwaps(swaps);
            return false;
        }
        if (PathExists(swap.target)) {
            if (!RenameReplace(swap.target, swap.backup)) {
                RollbackStagedSwaps(swaps);
                return false;
            }
            swap.had_target = true;
        }
        if (!RenameReplace(swap.staged, swap.target)) {
            if (swap.had_target) {
                if (RenameReplace(swap.backup, swap.target)) {
                    swap.had_target = false;
                } else {
                    ESP_LOGE(kTag, "Restore %s after failed stage install failed", swap.target.c_str());
                }
            }
            RollbackStagedSwaps(swaps);
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

}  // namespace

namespace cache {

bool Init() {
    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path               = kRoot;
    cfg.partition_label         = "storage";
    cfg.format_if_mount_failed  = true;
    cfg.dont_mount              = false;

    esp_err_t err = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "Littlefs mount failed: %s", esp_err_to_name(err));
        return false;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(cfg.partition_label, &total, &used);
    DirEnsure(std::string(kRoot) + "/groups");
    return true;
}

bool FormatAll() {
    constexpr char kLabel[] = "storage";
    ESP_LOGW(kTag, "FormatAll: erasing all littlefs cache");
    // unregister 失败一般是因为没 mount,format 仍可继续。
    esp_err_t err = esp_vfs_littlefs_unregister(kLabel);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(kTag, "Littlefs unregister failed (continuing): %s", esp_err_to_name(err));
    }
    err = esp_littlefs_format(kLabel);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "Littlefs format failed: %s", esp_err_to_name(err));
        return false;
    }
    // 重新 mount,让进程后续仍能用 cache(factory_reset 通常紧接 esp_restart,
    // 但 remount 让本函数语义独立 — 不依赖调用方一定重启)。
    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path               = kRoot;
    cfg.partition_label         = kLabel;
    cfg.format_if_mount_failed  = true;
    cfg.dont_mount              = false;
    err                         = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "Littlefs remount after format failed: %s", esp_err_to_name(err));
        return false;
    }
    DirEnsure(std::string(kRoot) + "/groups");
    return true;
}

bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    StateJson state = ReadStateJsonUnlocked();
    if (!state.root)
        return false;
    selected_group_id = JsonStringField(state.root, "selected_group_id");
    last_etag         = JsonStringField(state.root, "last_etag");
    return true;
}

bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    StateJson state             = ReadStateJsonUnlocked();
    int       current_frame_seq = state.root ? JsonNonNegativeIntField(state.root, "current_frame_seq", 0) : 0;
    return WriteStateJsonUnlocked(selected_group_id, etag, current_frame_seq);
}

std::string ReadCurrentManifestEtag() {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return "";
    StateJson state = ReadStateJsonUnlocked();
    if (!state.root)
        return "";
    return JsonStringField(state.root, "last_etag");
}

bool ReadCurrentFrameSeq(int& out) {
    out = 0;
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    StateJson state = ReadStateJsonUnlocked();
    if (!state.root)
        return false;
    cJSON* seq = cJSON_GetObjectItemCaseSensitive(state.root, "current_frame_seq");
    if (!cJSON_IsNumber(seq) || seq->valueint < 0)
        return false;
    out = seq->valueint;
    return true;
}

bool WriteCurrentFrameSeq(int seq) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    StateJson   state = ReadStateJsonUnlocked();
    std::string gid   = state.root ? JsonStringField(state.root, "selected_group_id") : "";
    std::string etag  = state.root ? JsonStringField(state.root, "last_etag") : "";
    return WriteStateJsonUnlocked(gid, etag, seq);
}

bool ReadCachedGroupSummary(CachedGroupSummary& out) {
    out = {};
    if (!ReadStateMeta(out.gid, out.manifest_etag) || out.gid.empty())
        return false;
    if (!ReadManifestContentCount(out.gid, out.content_count) || out.content_count <= 0) {
        out = {};
        return false;
    }
    return true;
}

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count) {
    DirEnsure(std::string(kRoot) + "/groups");
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "manifest_etag", manifest_etag.c_str());
    cJSON_AddNumberToObject(root, "content_count", content_count);
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(GroupDir(gid) + "/manifest.json", s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool ReadManifestContentCount(const std::string& gid, int& out) {
    std::vector<uint8_t> buf;
    if (!ReadAll(GroupDir(gid) + "/manifest.json", buf))
        return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root)
        return false;
    cJSON* fc = cJSON_GetObjectItemCaseSensitive(root, "content_count");
    bool   ok = false;
    if (cJSON_IsNumber(fc)) {
        out = fc->valueint;
        ok  = true;
    }
    cJSON_Delete(root);
    return ok;
}

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(ImagePath(gid, idx).c_str(), &st) != 0)
        return false;
    if (st.st_size != kFrameImageBytes)
        return false;
    return MatchEtag(EtagPath(gid, idx, "img"), expected_etag);
}

bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    if (bytes.size() != kFrameImageBytes) {
        ESP_LOGW(kTag, "Refuse frame image idx=%d: %u B, expected %u B", idx, static_cast<unsigned>(bytes.size()),
                 static_cast<unsigned>(kFrameImageBytes));
        return false;
    }
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(ImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    return WriteEtag(EtagPath(gid, idx, "img"), etag);
}

bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(ImagePath(gid, idx), out);
}

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(AudioPath(gid, idx).c_str(), &st) != 0)
        return false;
    return MatchEtag(EtagPath(gid, idx, "pcm"), expected_etag);
}

bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(AudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    return WriteEtag(EtagPath(gid, idx, "pcm"), etag);
}

bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(AudioPath(gid, idx), out);
}

namespace {
std::string MetaPath(const std::string& gid, int idx) {
    return FramesDir(gid) + "/" + std::to_string(idx) + ".meta";
}
std::string StageMetaPath(const std::string& gid, int idx) {
    return StageDir(gid) + "/" + std::to_string(idx) + ".meta";
}

bool WriteFrameMetaFile(const std::string& path, const FrameMeta& meta) {
    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "status_bar_text", meta.status_bar_text.c_str());
    cJSON_AddStringToObject(root, "content_etag", meta.content_etag.c_str());
    cJSON_AddStringToObject(root, "image_etag", meta.image_etag.c_str());
    cJSON_AddStringToObject(root, "audio_etag", meta.audio_etag.c_str());
    if (meta.has_ttl) {
        cJSON_AddNumberToObject(root, "ttl_sec", static_cast<double>(meta.ttl_sec));
    } else {
        cJSON_AddNullToObject(root, "ttl_sec");
    }
    char* s = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!s)
        return false;
    const size_t len = std::strlen(s);
    const bool   ok  = WriteAll(path, s, len);
    cJSON_free(s);
    return ok;
}
}  // namespace

void DeleteFrameAudio(const std::string& gid, int idx) {
    unlink(AudioPath(gid, idx).c_str());
    unlink(EtagPath(gid, idx, "pcm").c_str());
}

void DeleteFrameFiles(const std::string& gid, int idx) {
    unlink(ImagePath(gid, idx).c_str());
    unlink(EtagPath(gid, idx, "img").c_str());
    DeleteFrameAudio(gid, idx);
    unlink(MetaPath(gid, idx).c_str());
}

bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    return WriteFrameMetaFile(MetaPath(gid, idx), meta);
}

bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!ReadAll(MetaPath(gid, idx), buf) || buf.empty())
        return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root)
        return false;
    cJSON* cap        = cJSON_GetObjectItemCaseSensitive(root, "status_bar_text");
    cJSON* etag       = cJSON_GetObjectItemCaseSensitive(root, "content_etag");
    cJSON* image_etag = cJSON_GetObjectItemCaseSensitive(root, "image_etag");
    cJSON* audio_etag = cJSON_GetObjectItemCaseSensitive(root, "audio_etag");
    cJSON* ttl        = cJSON_GetObjectItemCaseSensitive(root, "ttl_sec");
    if (cJSON_IsString(cap) && cap->valuestring)
        out.status_bar_text = cap->valuestring;
    if (cJSON_IsString(etag) && etag->valuestring)
        out.content_etag = etag->valuestring;
    if (cJSON_IsString(image_etag) && image_etag->valuestring)
        out.image_etag = image_etag->valuestring;
    if (cJSON_IsString(audio_etag) && audio_etag->valuestring)
        out.audio_etag = audio_etag->valuestring;
    if (cJSON_IsNumber(ttl)) {
        // NaN / 负数 / 越界值直接 cast 到 uint32_t 是 UB；显式范围校验后再 cast。
        const double v = ttl->valuedouble;
        if (v >= 0.0 && v <= static_cast<double>(UINT32_MAX)) {
            out.has_ttl = true;
            out.ttl_sec = static_cast<uint32_t>(v);
        }
    }
    cJSON_Delete(root);
    return true;
}

bool BeginFrameStage(const std::string& gid) {
    if (gid.empty())
        return false;
    if (!RemoveTree(StageDir(gid)))
        return false;
    DirEnsure(std::string(kRoot) + "/groups");
    DirEnsure(GroupDir(gid));
    return DirEnsure(StageDir(gid));
}

void AbortFrameStage(const std::string& gid) {
    if (!gid.empty())
        RemoveTree(StageDir(gid));
}

bool StagedFrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(StageImagePath(gid, idx).c_str(), &st) == 0 && st.st_size == kFrameImageBytes &&
        MatchEtag(StageEtagPath(gid, idx, "img"), expected_etag)) {
        return true;
    }
    return FrameImageExists(gid, idx, expected_etag);
}

bool WriteStagedFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag) {
    if (bytes.size() != kFrameImageBytes) {
        ESP_LOGW(kTag, "Refuse staged frame image idx=%d: %u B, expected %u B", idx,
                 static_cast<unsigned>(bytes.size()), static_cast<unsigned>(kFrameImageBytes));
        return false;
    }
    DirEnsure(StageDir(gid));
    if (!WriteAll(StageImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    return WriteEtag(StageEtagPath(gid, idx, "img"), etag);
}

bool StagedFrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(StageAudioPath(gid, idx).c_str(), &st) == 0 && MatchEtag(StageEtagPath(gid, idx, "pcm"), expected_etag)) {
        return true;
    }
    return FrameAudioExists(gid, idx, expected_etag);
}

bool WriteStagedFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag) {
    DirEnsure(StageDir(gid));
    if (!WriteAll(StageAudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    return WriteEtag(StageEtagPath(gid, idx, "pcm"), etag);
}

bool WriteStagedFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    DirEnsure(StageDir(gid));
    return WriteFrameMetaFile(StageMetaPath(gid, idx), meta);
}

bool CommitStagedFrame(const std::string& gid, int idx, const std::string& image_etag,
                       const std::string& audio_etag) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));

    const std::string staged_image      = StageImagePath(gid, idx);
    const std::string staged_image_etag = StageEtagPath(gid, idx, "img");
    const std::string staged_meta       = StageMetaPath(gid, idx);
    const std::string staged_audio      = StageAudioPath(gid, idx);
    const std::string staged_audio_etag = StageEtagPath(gid, idx, "pcm");
    if (!PathExists(staged_meta)) {
        ESP_LOGW(kTag, "Missing staged meta for idx=%d", idx);
        return false;
    }
    if (PathExists(staged_image) && !PathExists(staged_image_etag)) {
        ESP_LOGW(kTag, "Missing staged image etag for idx=%d", idx);
        return false;
    }
    if (!PathExists(staged_image) && !FrameImageExists(gid, idx, image_etag)) {
        ESP_LOGW(kTag, "Missing committed/staged image for idx=%d", idx);
        return false;
    }
    if (!audio_etag.empty()) {
        if (PathExists(staged_audio) && !PathExists(staged_audio_etag)) {
            ESP_LOGW(kTag, "Missing staged audio etag for idx=%d", idx);
            return false;
        }
        if (!PathExists(staged_audio) && !FrameAudioExists(gid, idx, audio_etag)) {
            ESP_LOGW(kTag, "Missing committed/staged audio for idx=%d", idx);
            return false;
        }
    }

    std::vector<StagedSwap> swaps;
    if (PathExists(staged_image)) {
        swaps.push_back({staged_image, ImagePath(gid, idx), ImagePath(gid, idx) + ".bak"});
        swaps.push_back({staged_image_etag, EtagPath(gid, idx, "img"), EtagPath(gid, idx, "img") + ".bak"});
    }
    if (!audio_etag.empty() && PathExists(staged_audio)) {
        swaps.push_back({staged_audio, AudioPath(gid, idx), AudioPath(gid, idx) + ".bak"});
        swaps.push_back({staged_audio_etag, EtagPath(gid, idx, "pcm"), EtagPath(gid, idx, "pcm") + ".bak"});
    }
    // Metadata is installed last so the old metadata remains authoritative until
    // the image/audio payloads and etags are in place.
    swaps.push_back({staged_meta, MetaPath(gid, idx), MetaPath(gid, idx) + ".bak"});

    return CommitStagedSwaps(swaps);
}

}  // namespace cache
