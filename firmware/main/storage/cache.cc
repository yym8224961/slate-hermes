#include "cache.h"

#include <cJSON.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <unistd.h>

namespace {
constexpr char kTag[]  = "Cache";
constexpr char kRoot[] = "/littlefs";
}  // namespace

namespace {

bool DirEnsure(const std::string& dir) {
    struct stat st;
    if (stat(dir.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) return true;
    if (mkdir(dir.c_str(), 0775) == 0) return true;
    if (errno == EEXIST) return true;
    ESP_LOGW(kTag, "mkdir %s failed: %d", dir.c_str(), errno);
    return false;
}

// 原子写:写到 path.tmp 然后 rename。LittleFS rename 是原子的,
// 中途断电只会留下 .tmp(下次启动时无人 fopen 会自然忽略)或保持原文件不变。
bool WriteAll(const std::string& path, const void* data, size_t len) {
    const std::string tmp = path + ".tmp";
    FILE* f = fopen(tmp.c_str(), "wb");
    if (!f) {
        ESP_LOGW(kTag, "open w %s failed: %d", tmp.c_str(), errno);
        return false;
    }
    size_t w     = fwrite(data, 1, len, f);
    int    cret  = fclose(f);  // flush 失败(磁盘满)在这里才暴露
    if (w != len || cret != 0) {
        ESP_LOGW(kTag, "write %s short/flush failed (w=%u/%u close=%d)", tmp.c_str(),
                 (unsigned)w, (unsigned)len, cret);
        unlink(tmp.c_str());
        return false;
    }
    if (rename(tmp.c_str(), path.c_str()) != 0) {
        ESP_LOGW(kTag, "rename %s → %s failed: %d", tmp.c_str(), path.c_str(), errno);
        unlink(tmp.c_str());
        return false;
    }
    return true;
}

bool ReadAll(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return false;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return false;
    }
    long len = ftell(f);
    if (len < 0) {
        ESP_LOGW(kTag, "ftell %s failed: %d", path.c_str(), errno);
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

std::string GroupDir(const std::string& gid) {
    return std::string(kRoot) + "/groups/" + gid;
}
std::string FramesDir(const std::string& gid) {
    return GroupDir(gid) + "/frames";
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

bool MatchEtag(const std::string& path, const std::string& expected) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return false;
    char buf[128] = {0};
    fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    return expected == buf;
}

bool WriteEtag(const std::string& path, const std::string& etag) {
    return WriteAll(path, etag.data(), etag.size());
}

}  // namespace

namespace cache {

bool Init() {
    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path                = kRoot;
    cfg.partition_label          = "storage";
    cfg.format_if_mount_failed   = true;
    cfg.dont_mount               = false;

    esp_err_t err = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "littlefs mount failed: %s", esp_err_to_name(err));
        return false;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(cfg.partition_label, &total, &used);
    ESP_LOGI(kTag, "littlefs mounted at %s, %u/%u KB used",
             kRoot, (unsigned)(used / 1024), (unsigned)(total / 1024));
    DirEnsure(std::string(kRoot) + "/groups");
    return true;
}

bool FormatAll() {
    constexpr char kLabel[] = "storage";
    ESP_LOGW(kTag, "FormatAll: erasing all littlefs cache");
    // unregister 失败一般是因为没 mount,format 仍可继续。
    esp_err_t err = esp_vfs_littlefs_unregister(kLabel);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(kTag, "littlefs unregister failed (continuing): %s", esp_err_to_name(err));
    }
    err = esp_littlefs_format(kLabel);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "littlefs format failed: %s", esp_err_to_name(err));
        return false;
    }
    // 重新 mount,让进程后续仍能用 cache(factory_reset 通常紧接 esp_restart,
    // 但 remount 让本函数语义独立 — 不依赖调用方一定重启)。
    esp_vfs_littlefs_conf_t cfg = {};
    cfg.base_path                = kRoot;
    cfg.partition_label          = kLabel;
    cfg.format_if_mount_failed   = true;
    cfg.dont_mount               = false;
    err = esp_vfs_littlefs_register(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "littlefs remount after format failed: %s", esp_err_to_name(err));
        return false;
    }
    DirEnsure(std::string(kRoot) + "/groups");
    ESP_LOGI(kTag, "littlefs formatted + remounted");
    return true;
}

bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag) {
    std::vector<uint8_t> buf;
    if (!ReadAll(std::string(kRoot) + "/state.json", buf)) return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root) return false;
    cJSON* g = cJSON_GetObjectItemCaseSensitive(root, "selected_group_id");
    cJSON* e = cJSON_GetObjectItemCaseSensitive(root, "last_etag");
    if (cJSON_IsString(g)) selected_group_id = g->valuestring;
    if (cJSON_IsString(e)) last_etag = e->valuestring;
    cJSON_Delete(root);
    return true;
}

bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "selected_group_id", selected_group_id.c_str());
    cJSON_AddStringToObject(root, "last_etag", etag.c_str());
    char* s = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(std::string(kRoot) + "/state.json", s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool WriteManifest(const std::string& gid, const std::string& group_etag,
                   int frame_count, int default_frame_idx) {
    DirEnsure(std::string(kRoot) + "/groups");
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "group_etag", group_etag.c_str());
    cJSON_AddNumberToObject(root, "frame_count", frame_count);
    cJSON_AddNumberToObject(root, "default_frame_idx", default_frame_idx);
    char* s = cJSON_PrintUnformatted(root);
    bool  ok = s && WriteAll(GroupDir(gid) + "/manifest.json", s, std::strlen(s));
    cJSON_free(s);
    cJSON_Delete(root);
    return ok;
}

bool ReadManifestFrameCount(const std::string& gid, int& out) {
    std::vector<uint8_t> buf;
    if (!ReadAll(GroupDir(gid) + "/manifest.json", buf)) return false;
    cJSON* root = cJSON_ParseWithLength(reinterpret_cast<const char*>(buf.data()), buf.size());
    if (!root) return false;
    cJSON* fc = cJSON_GetObjectItemCaseSensitive(root, "frame_count");
    bool   ok = false;
    if (cJSON_IsNumber(fc)) {
        out = fc->valueint;
        ok = true;
    }
    cJSON_Delete(root);
    return ok;
}

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(ImagePath(gid, idx).c_str(), &st) != 0) return false;
    return MatchEtag(EtagPath(gid, idx, "img"), expected_etag);
}

bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                     const std::string& etag) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(ImagePath(gid, idx), bytes.data(), bytes.size())) return false;
    return WriteEtag(EtagPath(gid, idx, "img"), etag);
}

bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(ImagePath(gid, idx), out);
}

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    struct stat st;
    if (stat(AudioPath(gid, idx).c_str(), &st) != 0) return false;
    return MatchEtag(EtagPath(gid, idx, "pcm"), expected_etag);
}

bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                     const std::string& etag) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    if (!WriteAll(AudioPath(gid, idx), bytes.data(), bytes.size())) return false;
    return WriteEtag(EtagPath(gid, idx, "pcm"), etag);
}

bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return ReadAll(AudioPath(gid, idx), out);
}

namespace {
std::string CaptionPath(const std::string& gid, int idx) {
    return FramesDir(gid) + "/" + std::to_string(idx) + ".caption";
}
}  // namespace

bool WriteFrameCaption(const std::string& gid, int idx, const std::string& caption) {
    DirEnsure(GroupDir(gid));
    DirEnsure(FramesDir(gid));
    return WriteAll(CaptionPath(gid, idx), caption.data(), caption.size());
}

bool ReadFrameCaption(const std::string& gid, int idx, std::string& out) {
    std::vector<uint8_t> buf;
    if (!ReadAll(CaptionPath(gid, idx), buf)) {
        out.clear();
        return false;
    }
    out.assign(reinterpret_cast<const char*>(buf.data()), buf.size());
    return true;
}

}  // namespace cache
