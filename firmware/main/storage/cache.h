#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                 {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {group_etag, content_count}
//   /littlefs/groups/{gid}/frames/{idx}.img  15000 字节 1bpp
//   /littlefs/groups/{gid}/frames/{idx}.pcm  16k mono raw PCM

#include <cstdint>
#include <string>
#include <vector>

namespace cache {

bool Init();
bool FormatAll();

bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag);
bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag);

bool WriteManifest(const std::string& gid, const std::string& group_etag, int content_count);
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
    bool        has_ttl = false;
    uint32_t    ttl_sec = 0;
};
bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta);
bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out);

}  // namespace cache
