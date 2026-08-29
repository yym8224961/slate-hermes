#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>

#include "utils/utf8_utils.h"

namespace hermes {

inline constexpr size_t kRecordSampleRate  = 16000;
inline constexpr size_t kMaxRecordSeconds  = 15;
inline constexpr size_t kMaxRecordSamples  = kRecordSampleRate * kMaxRecordSeconds;
inline constexpr size_t kRecordChunkSamples = 512;
inline constexpr size_t kHistoryTextChars   = 512;

constexpr size_t Base64EncodedSize(size_t bytes) { return ((bytes + 2) / 3) * 4; }

constexpr size_t CaptureSamplesForChunk(size_t captured, size_t chunk_capacity) {
    if (captured >= kMaxRecordSamples)
        return 0;
    return std::min(chunk_capacity, kMaxRecordSamples - captured);
}

inline std::string LimitHistoryText(const std::string& text) {
    return util::Utf8PrefixChars(text, kHistoryTextChars);
}

static_assert(Base64EncodedSize(kMaxRecordSamples * sizeof(int16_t)) == 640000,
              "15-second PCM16 recording must fit the backend base64 contract");

}  // namespace hermes
