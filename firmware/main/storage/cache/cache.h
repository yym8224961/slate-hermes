#pragma once

// LittleFS 缓存:挂在 /littlefs,目录布局:
//   /littlefs/state.json                 {selected_group_id, last_etag}
//   /littlefs/groups/{gid}/manifest.json {group_id, group_name, manifest_etag, content_count, last_access_seq}
//   /littlefs/groups/{gid}/frames/{idx}.img  15000 字节 1bpp
//   /littlefs/groups/{gid}/frames/{idx}.pcm  16k mono raw PCM

#include <cstddef>
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
    std::string name;
    std::string manifest_etag;
    int         content_count = 0;
};
bool ReadCachedGroupSummary(CachedGroupSummary& out);

struct ManifestMeta {
    std::string gid;
    std::string name;
    std::string manifest_etag;
    int         content_count   = 0;
    uint32_t    last_access_seq = 0;
};

bool WriteManifest(const std::string& gid, const std::string& manifest_etag, int content_count,
                   const std::string& name = "");
bool ReadManifestMeta(const std::string& gid, ManifestMeta& out);
bool ReadManifestContentCount(const std::string& gid, int& out);
bool TouchGroup(const std::string& gid);
bool PruneOldGroups(const std::string& current_gid, const std::string& target_gid, size_t min_free_bytes,
                    int max_groups);

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

class CacheWriter {
   public:
    explicit CacheWriter(std::string gid);
    ~CacheWriter();

    CacheWriter(const CacheWriter&)            = delete;
    CacheWriter& operator=(const CacheWriter&) = delete;

    bool Begin();
    bool FrameImageExists(int idx, const std::string& expected_etag) const;
    bool WriteFrameImage(int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
    bool FrameAudioExists(int idx, const std::string& expected_etag) const;
    bool WriteFrameAudio(int idx, const std::vector<uint8_t>& bytes, const std::string& etag);
    bool WriteFrameMeta(int idx, const FrameMeta& meta);
    bool CommitFrame(int idx, const std::string& image_etag, const std::string& audio_etag);
    bool Commit();
    void Rollback();

   private:
    std::string gid_;
    bool        begun_     = false;
    bool        committed_ = false;
};

}  // namespace cache
