#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace xiaozhi {

constexpr int    kOpusFrameDurationMs     = 60;
constexpr int    kClientSampleRate        = 16000;
constexpr size_t kAudioInlinePayloadBytes = 1536;

constexpr bool IsSupportedOpusSampleRate(int sample_rate) {
    return sample_rate == 8000 || sample_rate == 16000 || sample_rate == 24000 || sample_rate == 48000;
}

constexpr bool IsSupportedOpusFrameDuration(int frame_duration_ms) {
    return frame_duration_ms == 5 || frame_duration_ms == 10 || frame_duration_ms == 20 || frame_duration_ms == 40 ||
           frame_duration_ms == 60 || frame_duration_ms == 80 || frame_duration_ms == 100 || frame_duration_ms == 120;
}

class AudioPayloadBuffer {
   public:
    void assign(const uint8_t* begin, const uint8_t* end) {
        const size_t len = static_cast<size_t>(end - begin);
        resize(len);
        if (len > 0)
            std::memcpy(data(), begin, len);
    }

    void resize(size_t len) {
        size_ = len;
        if (len <= inline_.size()) {
            use_heap_ = false;
            return;
        }
        use_heap_ = true;
        heap_.resize(len);
    }

    void clear() {
        size_     = 0;
        use_heap_ = false;
    }

    uint8_t* data() {
        return use_heap_ ? heap_.data() : inline_.data();
    }
    const uint8_t* data() const {
        return use_heap_ ? heap_.data() : inline_.data();
    }
    size_t size() const {
        return size_;
    }
    bool empty() const {
        return size_ == 0;
    }

   private:
    std::array<uint8_t, kAudioInlinePayloadBytes> inline_{};
    std::vector<uint8_t>                          heap_;
    size_t                                        size_     = 0;
    bool                                          use_heap_ = false;
};

struct AudioStreamPacket {
    static void* operator new(size_t size);
    static void  operator delete(void* ptr) noexcept;
    static void  operator delete(void* ptr, size_t size) noexcept;

    int                sample_rate    = 0;
    int                frame_duration = 0;
    uint32_t           timestamp      = 0;
    uint32_t           epoch          = 0;
    AudioPayloadBuffer payload;
};

}  // namespace xiaozhi
