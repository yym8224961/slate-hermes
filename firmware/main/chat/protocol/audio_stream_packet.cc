#include "xiaozhi_protocol.h"

#include <mutex>
#include <new>

namespace xiaozhi {
namespace {

constexpr size_t kAudioPacketPoolSize = 12;

alignas(AudioStreamPacket) uint8_t s_audio_packet_pool[kAudioPacketPoolSize][sizeof(AudioStreamPacket)];
bool       s_audio_packet_used[kAudioPacketPoolSize] = {};
std::mutex s_audio_packet_pool_mutex;

bool PoolIndexForPtr(void* ptr, size_t& index) {
    auto* raw = static_cast<uint8_t*>(ptr);
    for (size_t i = 0; i < kAudioPacketPoolSize; ++i) {
        if (raw == s_audio_packet_pool[i]) {
            index = i;
            return true;
        }
    }
    return false;
}

}  // namespace

void* AudioStreamPacket::operator new(size_t size) {
    if (size == sizeof(AudioStreamPacket)) {
        std::lock_guard<std::mutex> lock(s_audio_packet_pool_mutex);
        for (size_t i = 0; i < kAudioPacketPoolSize; ++i) {
            if (!s_audio_packet_used[i]) {
                s_audio_packet_used[i] = true;
                return s_audio_packet_pool[i];
            }
        }
    }
    return ::operator new(size);
}

void AudioStreamPacket::operator delete(void* ptr) noexcept {
    if (!ptr)
        return;
    size_t index = 0;
    if (PoolIndexForPtr(ptr, index)) {
        std::lock_guard<std::mutex> lock(s_audio_packet_pool_mutex);
        s_audio_packet_used[index] = false;
        return;
    }
    ::operator delete(ptr);
}

void AudioStreamPacket::operator delete(void* ptr, size_t /*size*/) noexcept {
    operator delete(ptr);
}

}  // namespace xiaozhi
