#include "cache.h"

#include <cJSON.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <dirent.h>
#include <unistd.h>
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cache_staging.h"
#include "config.h"
#include "frame_view.h"
#include "scoped_mutex_lock.h"

namespace {
constexpr char kTag[]                = "Cache";
constexpr char kRoot[]               = "/littlefs";
constexpr long kMaxAudioReadBytes    = AUDIO_MAX_PCM_BYTES;
constexpr long kMaxStateJsonBytes    = 4 * 1024;
constexpr long kMaxManifestJsonBytes = 64 * 1024;
constexpr long kMaxFrameMetaBytes    = 2 * 1024;
constexpr long kFrameImageBytes      = FrameView::kRawBytes;
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

bool ReadAll(const std::string& path, std::vector<uint8_t>& out, long max_read_bytes) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode))
        return false;
    const off_t len = st.st_size;
    if (len < 0)
        return false;
    if (len > max_read_bytes) {
        ESP_LOGW(kTag, "Read %s refused: %ld B exceeds limit", path.c_str(), len);
        return false;
    }
    FILE* f = fopen(path.c_str(), "rb");
    if (!f)
        return false;
    out.resize(static_cast<size_t>(len));
    size_t r = fread(out.data(), 1, static_cast<size_t>(len), f);
    fclose(f);
    return r == static_cast<size_t>(len);
}

std::string SafePathComponent(const std::string& raw) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string           out;
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

struct StateCache {
    bool        loaded = false;
    bool        exists = false;
    std::string selected_group_id;
    std::string last_etag;
    int         current_frame_seq = 0;
    uint32_t    cache_access_seq  = 0;
};

StateCache& StateCacheUnlocked() {
    static StateCache s_cache;
    return s_cache;
}

StateJson ReadStateJsonUnlocked() {
    StateJson            state;
    std::vector<uint8_t> buf;
    if (!ReadAll(StatePath(), buf, kMaxStateJsonBytes))
        return state;
    state.root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    return state;
}

void ResetStateCacheUnlocked() {
    auto& cache             = StateCacheUnlocked();
    cache.loaded            = false;
    cache.exists            = false;
    cache.selected_group_id = "";
    cache.last_etag         = "";
    cache.current_frame_seq = 0;
    cache.cache_access_seq  = 0;
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

uint32_t JsonUint32Field(cJSON* root, const char* key, uint32_t default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(value))
        return default_value;
    const double v = value->valuedouble;
    if (v < 0.0 || v > static_cast<double>(UINT32_MAX))
        return default_value;
    return static_cast<uint32_t>(v);
}

bool WriteStateJsonUnlocked(const std::string& selected_group_id, const std::string& etag, int current_frame_seq,
                            uint32_t cache_access_seq) {
    if (current_frame_seq < 0)
        current_frame_seq = 0;

    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "selected_group_id", selected_group_id.c_str());
    cJSON_AddStringToObject(root, "last_etag", etag.c_str());
    cJSON_AddNumberToObject(root, "current_frame_seq", current_frame_seq);
    cJSON_AddNumberToObject(root, "cache_access_seq", static_cast<double>(cache_access_seq));
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(StatePath(), s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool LoadStateCacheUnlocked() {
    auto& cache = StateCacheUnlocked();
    if (cache.loaded)
        return cache.exists;

    StateJson state = ReadStateJsonUnlocked();
    cache.loaded    = true;
    if (!state.root) {
        cache.exists            = false;
        cache.selected_group_id = "";
        cache.last_etag         = "";
        cache.current_frame_seq = 0;
        cache.cache_access_seq  = 0;
        return false;
    }

    cache.exists            = true;
    cache.selected_group_id = JsonStringField(state.root, "selected_group_id");
    cache.last_etag         = JsonStringField(state.root, "last_etag");
    cache.current_frame_seq = JsonNonNegativeIntField(state.root, "current_frame_seq", 0);
    cache.cache_access_seq  = JsonUint32Field(state.root, "cache_access_seq", 0);
    return true;
}

bool PersistStateCacheUnlocked() {
    auto& cache  = StateCacheUnlocked();
    cache.loaded = true;
    cache.exists = true;
    return WriteStateJsonUnlocked(cache.selected_group_id, cache.last_etag, cache.current_frame_seq,
                                  cache.cache_access_seq);
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
bool RemoveTreeInternal(const std::string& path, int depth) {
    constexpr int kMaxRemoveTreeDepth = 16;
    if (depth > kMaxRemoveTreeDepth) {
        ESP_LOGW(kTag, "RemoveTree refused: depth>%d at %s", kMaxRemoveTreeDepth, path.c_str());
        return false;
    }
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
            ok = RemoveTreeInternal(child, depth + 1) && ok;
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

bool RemoveTree(const std::string& path) {
    return RemoveTreeInternal(path, 0);
}

bool PathExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

bool RemoveIfExists(const std::string& path) {
    if (unlink(path.c_str()) == 0 || errno == ENOENT)
        return true;
    ESP_LOGW(kTag, "Unlink %s failed: %d", path.c_str(), errno);
    return false;
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
    {
        ScopedMutexLock lock(StateMutex());
        if (lock.locked())
            ResetStateCacheUnlocked();
    }
    DirEnsure(std::string(kRoot) + "/groups");
    return true;
}

bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    if (!LoadStateCacheUnlocked())
        return false;
    const auto& cache = StateCacheUnlocked();
    selected_group_id = cache.selected_group_id;
    last_etag         = cache.last_etag;
    return true;
}

bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    LoadStateCacheUnlocked();
    auto& cache             = StateCacheUnlocked();
    cache.selected_group_id = selected_group_id;
    cache.last_etag         = etag;
    return PersistStateCacheUnlocked();
}

std::string ReadCurrentManifestEtag() {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return "";
    if (!LoadStateCacheUnlocked())
        return "";
    return StateCacheUnlocked().last_etag;
}

bool ReadCurrentFrameSeq(int& out) {
    out = 0;
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    if (!LoadStateCacheUnlocked())
        return false;
    out = StateCacheUnlocked().current_frame_seq;
    return true;
}

bool WriteCurrentFrameSeq(int seq) {
    ScopedMutexLock lock(StateMutex());
    if (!lock.locked())
        return false;
    LoadStateCacheUnlocked();
    auto& cache             = StateCacheUnlocked();
    cache.current_frame_seq = seq < 0 ? 0 : seq;
    return PersistStateCacheUnlocked();
}

bool ReadCachedGroupSummary(CachedGroupSummary& out) {
    out = {};
    if (!ReadStateMeta(out.gid, out.manifest_etag) || out.gid.empty())
        return false;
    ManifestMeta meta;
    if (!ReadManifestMeta(out.gid, meta)) {
        out = {};
        return false;
    }
    out.name          = meta.name;
    out.manifest_etag = meta.manifest_etag;
    out.content_count = meta.content_count;
    return true;
}

namespace {
std::string ManifestPath(const std::string& gid) {
    return GroupDir(gid) + "/manifest.json";
}

bool ReadManifestMetaFile(const std::string& path, ManifestMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!ReadAll(path, buf, kMaxManifestJsonBytes))
        return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root)
        return false;
    out.gid             = JsonStringField(root, "group_id");
    out.name            = JsonStringField(root, "group_name");
    out.manifest_etag   = JsonStringField(root, "manifest_etag");
    out.content_count   = JsonNonNegativeIntField(root, "content_count", 0);
    out.last_access_seq = JsonUint32Field(root, "last_access_seq", 0);
    cJSON_Delete(root);
    return !out.manifest_etag.empty();
}
}  // namespace

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count,
                   const std::string& name) {
    DirEnsure(std::string(kRoot) + "/groups");
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    ManifestMeta old;
    ReadManifestMeta(gid, old);
    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "group_id", gid.c_str());
    cJSON_AddStringToObject(root, "group_name", name.empty() ? old.name.c_str() : name.c_str());
    cJSON_AddStringToObject(root, "manifest_etag", manifest_etag.c_str());
    cJSON_AddNumberToObject(root, "content_count", content_count);
    cJSON_AddNumberToObject(root, "last_access_seq", static_cast<double>(old.last_access_seq));
    char* s  = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(ManifestPath(gid), s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool ReadManifestMeta(const std::string& gid, ManifestMeta& out) {
    if (!ReadManifestMetaFile(ManifestPath(gid), out))
        return false;
    if (out.gid.empty())
        out.gid = gid;
    return true;
}

bool ReadManifestContentCount(const std::string& gid, int& out) {
    ManifestMeta meta;
    if (!ReadManifestMeta(gid, meta))
        return false;
    out = meta.content_count;
    return true;
}

bool TouchGroup(const std::string& gid) {
    if (gid.empty())
        return false;

    uint32_t next_seq = 1;
    {
        ScopedMutexLock lock(StateMutex());
        if (!lock.locked())
            return false;
        LoadStateCacheUnlocked();
        auto& cache            = StateCacheUnlocked();
        next_seq               = cache.cache_access_seq == UINT32_MAX ? UINT32_MAX : cache.cache_access_seq + 1;
        cache.cache_access_seq = next_seq;
        if (!PersistStateCacheUnlocked())
            return false;
    }

    // SyncService is the only writer of manifest access metadata. Keep the
    // state counter update atomic, then rewrite this group's manifest outside
    // StateMutex so UI/cache readers are not blocked by flash I/O.
    ManifestMeta meta;
    if (!ReadManifestMeta(gid, meta))
        return false;
    meta.last_access_seq = next_seq;

    cJSON* root = cJSON_CreateObject();
    if (!root)
        return false;
    cJSON_AddStringToObject(root, "group_id", meta.gid.empty() ? gid.c_str() : meta.gid.c_str());
    cJSON_AddStringToObject(root, "group_name", meta.name.c_str());
    cJSON_AddStringToObject(root, "manifest_etag", meta.manifest_etag.c_str());
    cJSON_AddNumberToObject(root, "content_count", meta.content_count);
    cJSON_AddNumberToObject(root, "last_access_seq", static_cast<double>(meta.last_access_seq));
    char* s = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!s)
        return false;
    const bool ok = WriteAll(ManifestPath(gid), s, std::strlen(s));
    cJSON_free(s);
    return ok;
}

bool PruneOldGroups(const std::string& current_gid, const std::string& target_gid, size_t min_free_bytes,
                    int max_groups) {
    const std::string groups_dir  = std::string(kRoot) + "/groups";
    const std::string current_dir = current_gid.empty() ? "" : GroupDir(current_gid);
    const std::string target_dir  = target_gid.empty() ? "" : GroupDir(target_gid);

    struct Candidate {
        std::string path;
        uint32_t    last_access_seq = 0;
    };
    std::vector<Candidate> candidates;
    int                    group_count = 0;

    DIR* dir = opendir(groups_dir.c_str());
    if (!dir)
        return errno == ENOENT;
    while (struct dirent* ent = readdir(dir)) {
        if (std::strcmp(ent->d_name, ".") == 0 || std::strcmp(ent->d_name, "..") == 0)
            continue;
        const std::string child = groups_dir + "/" + ent->d_name;
        struct stat       st;
        if (stat(child.c_str(), &st) != 0 || !S_ISDIR(st.st_mode))
            continue;
        ++group_count;
        if (child == current_dir || child == target_dir)
            continue;
        ManifestMeta meta;
        ReadManifestMetaFile(child + "/manifest.json", meta);
        candidates.push_back({child, meta.last_access_seq});
    }
    closedir(dir);

    std::sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
        if (a.last_access_seq != b.last_access_seq)
            return a.last_access_seq < b.last_access_seq;
        return a.path < b.path;
    });

    auto free_bytes = []() -> size_t {
        size_t total = 0, used = 0;
        if (esp_littlefs_info("storage", &total, &used) != ESP_OK || total < used)
            return 0;
        return total - used;
    };

    bool ok = true;
    for (const auto& c : candidates) {
        if ((max_groups <= 0 || group_count <= max_groups) && free_bytes() >= min_free_bytes)
            break;
        ESP_LOGI(kTag, "Prune cached content group: %s", c.path.c_str());
        ok = RemoveTree(c.path) && ok;
        --group_count;
    }
    return ok;
}

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(ImagePath(gid, idx).c_str(), &st) != 0)
        return false;
    if (st.st_size != kFrameImageBytes)
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.image_etag == expected_etag;
}

bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    (void)etag;
    if (bytes.size() != kFrameImageBytes) {
        ESP_LOGW(kTag, "Refuse frame image idx=%d: %u B, expected %u B", idx, static_cast<unsigned>(bytes.size()),
                 static_cast<unsigned>(kFrameImageBytes));
        return false;
    }
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(ImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    RemoveIfExists(EtagPath(gid, idx, "img"));
    return true;
}

bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(ImagePath(gid, idx), out, kFrameImageBytes);
}

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(AudioPath(gid, idx).c_str(), &st) != 0)
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.audio_etag == expected_etag;
}

bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    (void)etag;
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(AudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    RemoveIfExists(EtagPath(gid, idx, "pcm"));
    return true;
}

bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(AudioPath(gid, idx), out, kMaxAudioReadBytes);
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

bool ReadFrameMetaFile(const std::string& path, FrameMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!ReadAll(path, buf, kMaxFrameMetaBytes) || buf.empty())
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
        const double v = ttl->valuedouble;
        if (v >= 0.0 && v <= static_cast<double>(UINT32_MAX)) {
            out.has_ttl = true;
            out.ttl_sec = static_cast<uint32_t>(v);
        }
    }
    cJSON_Delete(root);
    return true;
}

bool UpdateStagedFrameEtag(const std::string& gid, int idx, const std::string& image_etag,
                           const std::string& audio_etag) {
    FrameMeta meta;
    ReadFrameMetaFile(StageMetaPath(gid, idx), meta);
    if (!image_etag.empty())
        meta.image_etag = image_etag;
    if (!audio_etag.empty())
        meta.audio_etag = audio_etag;
    return WriteFrameMetaFile(StageMetaPath(gid, idx), meta);
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
    return ReadFrameMetaFile(MetaPath(gid, idx), out);
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

void CleanupFrameStage(const std::string& gid) {
    if (!gid.empty())
        RemoveTree(StageDir(gid));
}

bool StagedFrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(StageImagePath(gid, idx).c_str(), &st) == 0 && st.st_size == kFrameImageBytes) {
        FrameMeta meta;
        if (ReadFrameMetaFile(StageMetaPath(gid, idx), meta) && meta.image_etag == expected_etag)
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
    RemoveIfExists(StageDir(gid) + "/" + std::to_string(idx) + ".img.etag");
    return UpdateStagedFrameEtag(gid, idx, etag, "");
}

bool StagedFrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(StageAudioPath(gid, idx).c_str(), &st) == 0) {
        FrameMeta meta;
        if (ReadFrameMetaFile(StageMetaPath(gid, idx), meta) && meta.audio_etag == expected_etag)
            return true;
    }
    return FrameAudioExists(gid, idx, expected_etag);
}

bool WriteStagedFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag) {
    DirEnsure(StageDir(gid));
    if (!WriteAll(StageAudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    RemoveIfExists(StageDir(gid) + "/" + std::to_string(idx) + ".pcm.etag");
    return UpdateStagedFrameEtag(gid, idx, "", etag);
}

bool WriteStagedFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    DirEnsure(StageDir(gid));
    return WriteFrameMetaFile(StageMetaPath(gid, idx), meta);
}

bool CommitStagedFrame(const std::string& gid, int idx, const std::string& image_etag, const std::string& audio_etag) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));

    const std::string staged_image = StageImagePath(gid, idx);
    const std::string staged_meta  = StageMetaPath(gid, idx);
    const std::string staged_audio = StageAudioPath(gid, idx);
    FrameMeta         staged_frame_meta;
    if (!ReadFrameMetaFile(staged_meta, staged_frame_meta)) {
        ESP_LOGW(kTag, "Missing staged meta for idx=%d", idx);
        return false;
    }
    if (staged_frame_meta.image_etag != image_etag) {
        ESP_LOGW(kTag, "Staged image etag mismatch for idx=%d", idx);
        return false;
    }
    if (!PathExists(staged_image) && !FrameImageExists(gid, idx, image_etag)) {
        ESP_LOGW(kTag, "Missing committed/staged image for idx=%d", idx);
        return false;
    }
    if (!audio_etag.empty()) {
        if (staged_frame_meta.audio_etag != audio_etag) {
            ESP_LOGW(kTag, "Staged audio etag mismatch for idx=%d", idx);
            return false;
        }
        if (!PathExists(staged_audio) && !FrameAudioExists(gid, idx, audio_etag)) {
            ESP_LOGW(kTag, "Missing committed/staged audio for idx=%d", idx);
            return false;
        }
    }

    std::vector<staging::Swap> swaps;
    if (PathExists(staged_image)) {
        swaps.push_back({staged_image, ImagePath(gid, idx), ImagePath(gid, idx) + ".bak"});
    }
    if (!audio_etag.empty() && PathExists(staged_audio)) {
        swaps.push_back({staged_audio, AudioPath(gid, idx), AudioPath(gid, idx) + ".bak"});
    }
    // Metadata is installed last so the old metadata remains authoritative until
    // the image/audio payloads are in place.
    swaps.push_back({staged_meta, MetaPath(gid, idx), MetaPath(gid, idx) + ".bak"});

    const bool ok = staging::CommitSwaps(swaps);
    if (ok) {
        RemoveIfExists(EtagPath(gid, idx, "img"));
        RemoveIfExists(EtagPath(gid, idx, "pcm"));
    }
    return ok;
}

}  // namespace cache
