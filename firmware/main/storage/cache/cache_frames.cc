#include "storage/cache/cache.h"

#include <cJSON.h>
#include <esp_log.h>
#include <sys/stat.h>

#include <unistd.h>
#include <cstdint>
#include <cstring>
#include <utility>

#include "storage/cache/cache_io.h"
#include "storage/cache/cache_paths.h"
#include "storage/cache/cache_staging.h"

namespace {

bool WriteFrameMetaFile(const std::string& path, const cache::FrameMeta& meta) {
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
    const bool   ok  = cache::internal::WriteAll(path, s, len);
    cJSON_free(s);
    return ok;
}

bool ReadFrameMetaFile(const std::string& path, cache::FrameMeta& out) {
    out = {};
    std::vector<uint8_t> buf;
    if (!cache::internal::ReadAll(path, buf, cache::internal::kMaxFrameMetaBytes) || buf.empty())
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
    cache::FrameMeta meta;
    ReadFrameMetaFile(cache::internal::StageMetaPath(gid, idx), meta);
    if (!image_etag.empty())
        meta.image_etag = image_etag;
    if (!audio_etag.empty())
        meta.audio_etag = audio_etag;
    return WriteFrameMetaFile(cache::internal::StageMetaPath(gid, idx), meta);
}

}  // namespace

namespace cache {

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::ImagePath(gid, idx).c_str(), &st) != 0)
        return false;
    if (st.st_size != internal::kFrameImageBytes)
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.image_etag == expected_etag;
}

bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    (void)etag;
    if (bytes.size() != internal::kFrameImageBytes) {
        ESP_LOGW(internal::kTag, "Refuse frame image idx=%d: %u B, expected %u B", idx,
                 static_cast<unsigned>(bytes.size()), static_cast<unsigned>(internal::kFrameImageBytes));
        return false;
    }
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    if (!internal::WriteAll(internal::ImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "img"));
    return true;
}

bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return internal::ReadAll(internal::ImagePath(gid, idx), out, internal::kFrameImageBytes);
}

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::AudioPath(gid, idx).c_str(), &st) != 0)
        return false;
    FrameMeta meta;
    return ReadFrameMeta(gid, idx, meta) && meta.audio_etag == expected_etag;
}

bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    (void)etag;
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    if (!internal::WriteAll(internal::AudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::EtagPath(gid, idx, "pcm"));
    return true;
}

bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out) {
    return internal::ReadAll(internal::AudioPath(gid, idx), out, internal::kMaxAudioReadBytes);
}

void DeleteFrameAudio(const std::string& gid, int idx) {
    unlink(internal::AudioPath(gid, idx).c_str());
    unlink(internal::EtagPath(gid, idx, "pcm").c_str());
}

void DeleteFrameFiles(const std::string& gid, int idx) {
    unlink(internal::ImagePath(gid, idx).c_str());
    unlink(internal::EtagPath(gid, idx, "img").c_str());
    DeleteFrameAudio(gid, idx);
    unlink(internal::MetaPath(gid, idx).c_str());
}

bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));
    return WriteFrameMetaFile(internal::MetaPath(gid, idx), meta);
}

bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out) {
    return ReadFrameMetaFile(internal::MetaPath(gid, idx), out);
}

namespace {
bool BeginFrameStage(const std::string& gid) {
    if (gid.empty())
        return false;
    if (!internal::RemoveTree(internal::StageDir(gid)))
        return false;
    internal::DirEnsure(std::string(internal::kRoot) + "/groups");
    internal::DirEnsure(internal::GroupDir(gid));
    return internal::DirEnsure(internal::StageDir(gid));
}

void CleanupFrameStage(const std::string& gid) {
    if (!gid.empty())
        internal::RemoveTree(internal::StageDir(gid));
}

bool StagedFrameImageExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::StageImagePath(gid, idx).c_str(), &st) == 0 && st.st_size == internal::kFrameImageBytes) {
        FrameMeta meta;
        if (ReadFrameMetaFile(internal::StageMetaPath(gid, idx), meta) && meta.image_etag == expected_etag)
            return true;
    }
    return FrameImageExists(gid, idx, expected_etag);
}

bool WriteStagedFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag) {
    if (bytes.size() != internal::kFrameImageBytes) {
        ESP_LOGW(internal::kTag, "Refuse staged frame image idx=%d: %u B, expected %u B", idx,
                 static_cast<unsigned>(bytes.size()), static_cast<unsigned>(internal::kFrameImageBytes));
        return false;
    }
    internal::DirEnsure(internal::StageDir(gid));
    if (!internal::WriteAll(internal::StageImagePath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::StageDir(gid) + "/" + std::to_string(idx) + ".img.etag");
    return UpdateStagedFrameEtag(gid, idx, etag, "");
}

bool StagedFrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag) {
    if (expected_etag.empty())
        return false;
    struct stat st;
    if (stat(internal::StageAudioPath(gid, idx).c_str(), &st) == 0) {
        FrameMeta meta;
        if (ReadFrameMetaFile(internal::StageMetaPath(gid, idx), meta) && meta.audio_etag == expected_etag)
            return true;
    }
    return FrameAudioExists(gid, idx, expected_etag);
}

bool WriteStagedFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                           const std::string& etag) {
    internal::DirEnsure(internal::StageDir(gid));
    if (!internal::WriteAll(internal::StageAudioPath(gid, idx), bytes.data(), bytes.size()))
        return false;
    internal::RemoveIfExists(internal::StageDir(gid) + "/" + std::to_string(idx) + ".pcm.etag");
    return UpdateStagedFrameEtag(gid, idx, "", etag);
}

bool WriteStagedFrameMeta(const std::string& gid, int idx, const FrameMeta& meta) {
    internal::DirEnsure(internal::StageDir(gid));
    return WriteFrameMetaFile(internal::StageMetaPath(gid, idx), meta);
}

bool CommitStagedFrame(const std::string& gid, int idx, const std::string& image_etag, const std::string& audio_etag) {
    internal::DirEnsure(internal::GroupDir(gid));
    internal::DirEnsure(internal::FramesDir(gid));

    const std::string staged_image = internal::StageImagePath(gid, idx);
    const std::string staged_meta  = internal::StageMetaPath(gid, idx);
    const std::string staged_audio = internal::StageAudioPath(gid, idx);
    FrameMeta         staged_frame_meta;
    if (!ReadFrameMetaFile(staged_meta, staged_frame_meta)) {
        ESP_LOGW(internal::kTag, "Missing staged meta for idx=%d", idx);
        return false;
    }
    if (staged_frame_meta.image_etag != image_etag) {
        ESP_LOGW(internal::kTag, "Staged image etag mismatch for idx=%d", idx);
        return false;
    }
    if (!internal::PathExists(staged_image) && !FrameImageExists(gid, idx, image_etag)) {
        ESP_LOGW(internal::kTag, "Missing committed/staged image for idx=%d", idx);
        return false;
    }
    if (!audio_etag.empty()) {
        if (staged_frame_meta.audio_etag != audio_etag) {
            ESP_LOGW(internal::kTag, "Staged audio etag mismatch for idx=%d", idx);
            return false;
        }
        if (!internal::PathExists(staged_audio) && !FrameAudioExists(gid, idx, audio_etag)) {
            ESP_LOGW(internal::kTag, "Missing committed/staged audio for idx=%d", idx);
            return false;
        }
    }

    std::vector<staging::Swap> swaps;
    if (internal::PathExists(staged_image)) {
        swaps.push_back({staged_image, internal::ImagePath(gid, idx), internal::ImagePath(gid, idx) + ".bak"});
    }
    if (!audio_etag.empty() && internal::PathExists(staged_audio)) {
        swaps.push_back({staged_audio, internal::AudioPath(gid, idx), internal::AudioPath(gid, idx) + ".bak"});
    }
    swaps.push_back({staged_meta, internal::MetaPath(gid, idx), internal::MetaPath(gid, idx) + ".bak"});

    const bool ok = staging::CommitSwaps(swaps);
    if (ok) {
        internal::RemoveIfExists(internal::EtagPath(gid, idx, "img"));
        internal::RemoveIfExists(internal::EtagPath(gid, idx, "pcm"));
    }
    return ok;
}
}  // namespace

CacheWriter::CacheWriter(std::string gid) : gid_(std::move(gid)) {
}

CacheWriter::~CacheWriter() {
    Rollback();
}

bool CacheWriter::Begin() {
    if (begun_)
        return true;
    begun_ = BeginFrameStage(gid_);
    return begun_;
}

bool CacheWriter::FrameImageExists(int idx, const std::string& expected_etag) const {
    return begun_ && StagedFrameImageExists(gid_, idx, expected_etag);
}

bool CacheWriter::WriteFrameImage(int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    return begun_ && WriteStagedFrameImage(gid_, idx, bytes, etag);
}

bool CacheWriter::FrameAudioExists(int idx, const std::string& expected_etag) const {
    return begun_ && StagedFrameAudioExists(gid_, idx, expected_etag);
}

bool CacheWriter::WriteFrameAudio(int idx, const std::vector<uint8_t>& bytes, const std::string& etag) {
    return begun_ && WriteStagedFrameAudio(gid_, idx, bytes, etag);
}

bool CacheWriter::WriteFrameMeta(int idx, const FrameMeta& meta) {
    return begun_ && WriteStagedFrameMeta(gid_, idx, meta);
}

bool CacheWriter::CommitFrame(int idx, const std::string& image_etag, const std::string& audio_etag) {
    return begun_ && CommitStagedFrame(gid_, idx, image_etag, audio_etag);
}

bool CacheWriter::Commit() {
    if (!begun_)
        return false;
    committed_ = true;
    CleanupFrameStage(gid_);
    return true;
}

void CacheWriter::Rollback() {
    if (begun_ && !committed_)
        CleanupFrameStage(gid_);
    begun_ = false;
}

}  // namespace cache
