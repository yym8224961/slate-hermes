#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {group_etag, content_count}
//   /littlefs/groups/{gid}/frames/{idx}.img    15000 字节 1bpp
//   /littlefs/groups/{gid}/frames/{idx}.pcm    16k mono raw PCM

#include <cstdint>
#include <string>
#include <vector>

namespace cache {

bool Init();  // mount LittleFS,partition label "storage"

// 清空所有缓存(图片 / 音频 / manifest / state):unmount → format → remount。
// 用在 factory reset 流程,典型路径是 cred::Clear() 之后立即调,然后 esp_restart。
bool FormatAll();

// state.json
bool ReadStateMeta(std::string& selected_group_id, std::string& last_etag);
bool WriteStateMeta(const std::string& selected_group_id, const std::string& etag);

// manifest.json:存当前组的 etag + 内容数量,server 同步时更新
bool WriteManifest(const std::string& gid, const std::string& group_etag, int content_count);
bool ReadManifestContentCount(const std::string& gid, int& out);

// frame image:返回 etag 命中时 true(无需重拉)
bool FrameImageExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameImage(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool ReadFrameImage(const std::string& gid, int idx, std::vector<uint8_t>& out);

// frame audio
bool FrameAudioExists(const std::string& gid, int idx, const std::string& expected_etag);
bool WriteFrameAudio(const std::string& gid, int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
bool ReadFrameAudio(const std::string& gid, int idx, std::vector<uint8_t>& out);
void DeleteFrameAudio(const std::string& gid, int idx);
void DeleteFrameFiles(const std::string& gid, int idx);

// frame caption + 自动刷新 TTL 合并存到 .meta 文件（JSON）。
// 一个文件减一个 LittleFS inode，对大批 widget 帧的存储开销下降明显。
struct FrameMeta {
    std::string caption;
    uint32_t    ttl_sec = 0;  // 0 = 静态/无周期刷新
};
bool WriteFrameMeta(const std::string& gid, int idx, const FrameMeta& meta);
bool ReadFrameMeta(const std::string& gid, int idx, FrameMeta& out);

// 读 manifest.json 里的 content_count
// (重复声明放这里方便看,实际已在上方)

}  // namespace cache
