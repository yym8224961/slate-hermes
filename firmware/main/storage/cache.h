#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {group_etag, frame_count, default_idx,
//                                         frames: [{idx, image_etag, audio_etag}]}
//   /littlefs/groups/{gid}/frames/{idx}.img    15000 字节 1bpp
//   /littlefs/groups/{gid}/frames/{idx}.pcm    16k mono raw PCM

#include <cstdint>
#include <string>
#include <vector>

namespace cache {

bool Init();  // mount LittleFS,partition label "storage"

// state.json
bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag);
bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag);

// manifest.json:存当前组的 etag + frame 数量,server 同步时更新
bool WriteManifest(const std::string& gid, const std::string& group_etag,
                   int frame_count, int default_frame_idx);
bool ReadManifestFrameCount(const std::string& gid, int& out);

// frame image:返回 etag 命中时 true(无需重拉)
bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                     const std::string& etag);
bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out);

// frame audio
bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes,
                     const std::string& etag);
bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out);

// frame caption(中文标题,UTF-8 单行)。空字符串 = 没 caption。
bool WriteFrameCaption(const std::string& gid, int idx, const std::string& caption);
bool ReadFrameCaption(const std::string& gid, int idx, std::string& out);

// 读 manifest.json 里的 frame_count
// (重复声明放这里方便看,实际已在上方)

}  // namespace cache
