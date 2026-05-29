#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                 {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {manifest_etag, content_count}
//   /littlefs/groups/{gid}/frames/{idx}.img  15000 字节 1bpp
//   /littlefs/groups/{gid}/frames/{idx}.pcm  16k mono raw PCM

#include <cstdint>
#include <string>
#include <vector>

namespace cache {

bool Init();
bool FormatAll();

bool        ReadStateMeta(std::string& selected_group_id, std::string& last_etag);
bool        WriteStateMeta(const std::string& selected_group_id, const std::string& etag);
std::string ReadCurrentManifestEtag();
bool        ReadCurrentFrameSeq(int& out);
bool        WriteCurrentFrameSeq(int seq);

struct CachedGroupSummary {
    std::string gid;
    std::string manifest_etag;
    int         content_count = 0;
};
bool ReadCachedGroupSummary(CachedGroupSummary& out);

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count);
bool ReadManifestContentCount(const std::string& gid, int& out);

bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out);

bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out);
void DeleteFrameAudio(const std::string& gid, int idx);
void DeleteFrameFiles(const std::string& gid, int idx);

struct FrameMeta {
    std::string status_bar_text;
    std::string content_etag;
    std::string image_etag;
    std::string audio_etag;
    bool        has_ttl = false;
    uint32_t    ttl_sec = 0;
};
bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta);
bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out);

// Per-group staging area for multi-file frame updates. Writers can download all
// required frame files into the stage and only publish them after the batch is
// complete, so a failed sync does not partially overwrite the committed cache.
bool BeginFrameStage(const std::string& gid);
void CleanupFrameStage(const std::string& gid);
bool StagedFrameImageExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteStagedFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool StagedFrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteStagedFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool WriteStagedFrameMeta(const std::string& gid, int idx, const FrameMeta& meta);
bool CommitStagedFrame(const std::string& gid, int idx, const std::string& image_etag, const std::string& audio_etag);

}  // namespace cache
