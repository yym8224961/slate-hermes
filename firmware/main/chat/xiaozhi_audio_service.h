#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <vector>

#include "xiaozhi_protocol.h"

class AudioPlayer;

namespace xiaozhi {

class AudioService {
   public:
    static AudioService& Get();

    bool Start(AudioPlayer* player);
    void Stop();
    bool Begin(int xiaozhi_codec_volume);
    void End(int album_codec_volume);
    void SetVolume(int codec_volume);
    void EnableVoiceProcessing(bool enable);
    bool IsActive() const {
        return active_.load(std::memory_order_relaxed);
    }
    bool IsVoiceProcessing() const {
        return voice_processing_.load(std::memory_order_relaxed);
    }
    bool PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket> packet);
    void ResetDecoder();
    std::unique_ptr<AudioStreamPacket> PopPacketFromSendQueue();
    bool IsIdle();
    bool WaitForPlaybackQueueEmpty(int timeout_ms = 2000);
    void DumpDiagnostics(const char* reason);

   private:
    struct PcmTask {
        std::vector<int16_t> pcm;
        uint32_t timestamp = 0;
        uint32_t epoch = 0;
    };

    AudioService() = default;
    ~AudioService() = default;

    static void InputTaskEntry(void* arg);
    static void OutputTaskEntry(void* arg);
    static void CodecTaskEntry(void* arg);
    void InputTask();
    void OutputTask();
    void CodecTask();
    bool PushTaskToEncodeQueue(std::vector<int16_t>&& pcm);
    bool EnsureDecoderLocked(int sample_rate, int frame_duration);
    bool ResampleToDeviceRateLocked(std::vector<int16_t>& pcm, int sample_rate);
    void CloseCodecResources();
    void SignalTaskStopped();
    bool WaitForTasksToStop(int expected_count);

    AudioPlayer* player_ = nullptr;
    std::atomic<bool> started_{false};
    std::atomic<bool> active_{false};
    std::atomic<bool> voice_processing_{false};

    void* opus_encoder_ = nullptr;
    void* opus_decoder_ = nullptr;
    int encoder_frame_samples_ = 0;
    int encoder_input_bytes_ = 0;
    int encoder_output_bytes_ = 0;
    int decoder_sample_rate_ = 0;
    int decoder_frame_duration_ = 0;
    int decoder_frame_samples_ = 0;
    void* output_resampler_ = nullptr;

    std::mutex queue_mutex_;
    std::mutex codec_mutex_;
    std::deque<std::unique_ptr<PcmTask>> encode_queue_;
    std::deque<std::unique_ptr<AudioStreamPacket>> decode_queue_;
    std::deque<std::unique_ptr<PcmTask>> playback_queue_;
    std::deque<std::unique_ptr<AudioStreamPacket>> send_queue_;
    SemaphoreHandle_t decode_notify_ = nullptr;
    SemaphoreHandle_t playback_notify_ = nullptr;
    SemaphoreHandle_t send_notify_ = nullptr;
    SemaphoreHandle_t task_done_notify_ = nullptr;
    std::atomic<uint32_t> queue_epoch_{0};
    std::atomic<bool> decode_active_{false};
    std::atomic<bool> playback_active_{false};
    std::atomic<uint32_t> input_read_ok_{0};
    std::atomic<uint32_t> input_read_fail_{0};
    std::atomic<uint32_t> last_input_peak_{0};
    std::atomic<uint32_t> encode_ok_{0};
    std::atomic<uint32_t> encode_empty_{0};
    std::atomic<uint32_t> encode_fail_{0};
    std::atomic<uint32_t> send_pop_count_{0};
    std::atomic<uint32_t> decode_push_count_{0};
    std::atomic<uint32_t> playback_write_count_{0};
    std::atomic<int64_t> last_input_ok_ms_{0};
    std::atomic<int64_t> last_encode_ok_ms_{0};
    std::atomic<int64_t> last_send_pop_ms_{0};
    TaskHandle_t input_task_ = nullptr;
    TaskHandle_t output_task_ = nullptr;
    TaskHandle_t codec_task_ = nullptr;
};

}  // namespace xiaozhi
