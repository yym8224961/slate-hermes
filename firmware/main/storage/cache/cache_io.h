#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "bsp/config.h"
#include "ui/frame_view.h"

namespace cache::internal {

inline constexpr char kTag[]                = "cache";
inline constexpr long kMaxAudioReadBytes    = AUDIO_MAX_PCM_BYTES;
inline constexpr long kMaxStateJsonBytes    = 4 * 1024;
inline constexpr long kMaxManifestJsonBytes = 64 * 1024;
inline constexpr long kMaxFrameMetaBytes    = 2 * 1024;
inline constexpr long kFrameImageBytes      = FrameView::kRawBytes;

bool DirEnsure(const std::string& dir);
bool WriteAll(const std::string& path, const void* data, size_t len);
bool ReadAll(const std::string& path, std::vector<uint8_t>& out, long max_read_bytes);
bool RemoveTree(const std::string& path);
bool PathExists(const std::string& path);
bool RemoveIfExists(const std::string& path);

}  // namespace cache::internal
