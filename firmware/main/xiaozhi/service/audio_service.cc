#include "xiaozhi/service/audio_service.h"

#include <esp_ae_rate_cvt.h>
#include <esp_audio_dec.h>
#include <esp_audio_enc.h>
#include <esp_audio_types.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_opus_dec.h>
#include <esp_opus_enc.h>
#include <freertos/idf_additions.h>

#include <algorithm>
#include <cstring>

#include "drivers/audio/audio_player.h"
#include "utils/time_utils.h"
#include "storage/nvs/volume_store.h"

namespace {
constexpr char kTag[]            = "XiaoAudio";
constexpr int  kMaxEncodeTasks   = 2;
constexpr int  kMaxPlaybackTasks = 2;
constexpr int  kMaxDecodePackets = 2400 / xiaozhi::kOpusFrameDurationMs;
constexpr int  kMaxSendPackets   = 2400 / xiaozhi::kOpusFrameDurationMs;
constexpr int  kCodecTaskDelayMs = 20;

esp_opus_enc_frame_duration_t EncDurationEnum(int ms) {
    switch (ms) {
        case 5:
            return ESP_OPUS_ENC_FRAME_DURATION_5_MS;
        case 10:
            return ESP_OPUS_ENC_FRAME_DURATION_10_MS;
        case 20:
            return ESP_OPUS_ENC_FRAME_DURATION_20_MS;
        case 40:
            return ESP_OPUS_ENC_FRAME_DURATION_40_MS;
        case 60:
            return ESP_OPUS_ENC_FRAME_DURATION_60_MS;
        case 80:
            return ESP_OPUS_ENC_FRAME_DURATION_80_MS;
        case 100:
            return ESP_OPUS_ENC_FRAME_DURATION_100_MS;
        case 120:
            return ESP_OPUS_ENC_FRAME_DURATION_120_MS;
        default:
            return ESP_OPUS_ENC_FRAME_DURATION_60_MS;
    }
}

esp_opus_dec_frame_duration_t DecDurationEnum(int ms) {
    switch (ms) {
        case 5:
            return ESP_OPUS_DEC_FRAME_DURATION_5_MS;
        case 10:
            return ESP_OPUS_DEC_FRAME_DURATION_10_MS;
        case 20:
            return ESP_OPUS_DEC_FRAME_DURATION_20_MS;
        case 40:
            return ESP_OPUS_DEC_FRAME_DURATION_40_MS;
        case 60:
            return ESP_OPUS_DEC_FRAME_DURATION_60_MS;
        case 80:
            return ESP_OPUS_DEC_FRAME_DURATION_80_MS;
        case 100:
            return ESP_OPUS_DEC_FRAME_DURATION_100_MS;
        case 120:
            return ESP_OPUS_DEC_FRAME_DURATION_120_MS;
        default:
            return ESP_OPUS_DEC_FRAME_DURATION_60_MS;
    }
}
}  // namespace

namespace xiaozhi {

AudioService& AudioService::Get() {
    static AudioService s;
    return s;
}

bool AudioService::Start(AudioPlayer* player) {
    if (!player)
        return false;
    player_ = player;
    if (started_.load(std::memory_order_relaxed))
        return true;
    {
        std::lock_guard<std::mutex> task_lock(task_mutex_);
        if (input_task_ || output_task_ || codec_task_) {
            ESP_LOGW(kTag, "Audio service tasks are still stopping");
            return false;
        }
    }

    if (!decode_notify_)
        decode_notify_ = xSemaphoreCreateCounting(kMaxDecodePackets + kMaxEncodeTasks, 0);
    if (!playback_notify_)
        playback_notify_ = xSemaphoreCreateCounting(kMaxPlaybackTasks, 0);
    if (!send_notify_)
        send_notify_ = xSemaphoreCreateCounting(kMaxSendPackets, 0);
    if (!task_done_notify_)
        task_done_notify_ = xSemaphoreCreateCounting(3, 0);
    if (!decode_notify_ || !playback_notify_ || !send_notify_ || !task_done_notify_) {
        ESP_LOGE(kTag, "Failed to create queue semaphores");
        return false;
    }
    while (xSemaphoreTake(task_done_notify_, 0) == pdTRUE) {
    }
    CloseCodecResources();

    encoder_frame_samples_        = kClientSampleRate * kOpusFrameDurationMs / 1000;
    esp_opus_enc_config_t enc_cfg = {
        .sample_rate      = ESP_AUDIO_SAMPLE_RATE_16K,
        .channel          = ESP_AUDIO_MONO,
        .bits_per_sample  = ESP_AUDIO_BIT16,
        .bitrate          = ESP_OPUS_BITRATE_AUTO,
        .frame_duration   = EncDurationEnum(kOpusFrameDurationMs),
        .application_mode = ESP_OPUS_ENC_APPLICATION_AUDIO,
        .complexity       = 0,
        .enable_fec       = false,
        .enable_dtx       = true,
        .enable_vbr       = true,
    };
    auto ret = esp_opus_enc_open(&enc_cfg, sizeof(enc_cfg), &opus_encoder_);
    if (ret != ESP_AUDIO_ERR_OK || !opus_encoder_) {
        ESP_LOGE(kTag, "Failed to create encoder: %d", ret);
        CloseCodecResources();
        return false;
    }
    ret = esp_opus_enc_get_frame_size(opus_encoder_, &encoder_input_bytes_, &encoder_output_bytes_);
    if (ret != ESP_AUDIO_ERR_OK || encoder_input_bytes_ <= 0 || encoder_output_bytes_ <= 0) {
        ESP_LOGE(kTag, "Failed to get encoder frame size: %d", ret);
        CloseCodecResources();
        return false;
    }
    encoder_frame_samples_ = encoder_input_bytes_ / static_cast<int>(sizeof(int16_t));

    bool decoder_ready = false;
    {
        std::lock_guard<std::mutex> lock(codec_mutex_);
        decoder_ready = EnsureDecoderLocked(kClientSampleRate, kOpusFrameDurationMs);
    }
    if (!decoder_ready) {
        CloseCodecResources();
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        encode_queue_.clear();
        decode_queue_.clear();
        playback_queue_.clear();
        send_queue_.clear();
    }
    diag_.Reset();
    decode_active_.store(false, std::memory_order_relaxed);
    playback_active_.store(false, std::memory_order_relaxed);
    queue_epoch_.fetch_add(1, std::memory_order_relaxed);

    started_.store(true, std::memory_order_relaxed);
    {
        std::unique_lock<std::mutex> task_lock(task_mutex_);
        BaseType_t ok = xTaskCreatePinnedToCoreWithCaps(&AudioService::InputTaskEntry, "xiaozhi_in", 24 * 1024, this, 6,
                                                        &input_task_, 0, MALLOC_CAP_SPIRAM);
        if (ok != pdPASS) {
            ESP_LOGE(kTag, "Input task create failed: internal_free=%u largest=%u",
                     static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                     static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
            started_.store(false, std::memory_order_relaxed);
            input_task_ = nullptr;
            CloseCodecResources();
            return false;
        }

        ok = xTaskCreatePinnedToCoreWithCaps(&AudioService::CodecTaskEntry, "xiaozhi_codec", 24 * 1024, this, 4,
                                             &codec_task_, 1, MALLOC_CAP_SPIRAM);
        if (ok != pdPASS) {
            ESP_LOGE(kTag, "Codec task create failed: internal_free=%u largest=%u",
                     static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                     static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
            started_.store(false, std::memory_order_relaxed);
            xSemaphoreGive(decode_notify_);
            task_lock.unlock();
            const bool stopped = WaitForTasksToStop(1);
            if (stopped)
                CloseCodecResources();
            return false;
        }

        ok = xTaskCreatePinnedToCoreWithCaps(&AudioService::OutputTaskEntry, "xiaozhi_out", 16 * 1024, this, 5,
                                             &output_task_, 1, MALLOC_CAP_SPIRAM);
        if (ok != pdPASS) {
            ESP_LOGE(kTag, "Output task create failed: internal_free=%u largest=%u",
                     static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                     static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
            started_.store(false, std::memory_order_relaxed);
            xSemaphoreGive(decode_notify_);
            xSemaphoreGive(playback_notify_);
            task_lock.unlock();
            const bool stopped = WaitForTasksToStop(2);
            if (stopped)
                CloseCodecResources();
            return false;
        }
    }
    return true;
}

void AudioService::Stop() {
    started_.store(false, std::memory_order_relaxed);
    active_.store(false, std::memory_order_relaxed);
    voice_processing_.store(false, std::memory_order_relaxed);
    decode_active_.store(false, std::memory_order_relaxed);
    playback_active_.store(false, std::memory_order_relaxed);
    queue_epoch_.fetch_add(1, std::memory_order_relaxed);
    if (decode_notify_)
        xSemaphoreGive(decode_notify_);
    if (playback_notify_)
        xSemaphoreGive(playback_notify_);
    if (send_notify_)
        xSemaphoreGive(send_notify_);

    int expected = 0;
    {
        std::lock_guard<std::mutex> task_lock(task_mutex_);
        if (input_task_)
            ++expected;
        if (output_task_)
            ++expected;
        if (codec_task_)
            ++expected;
    }
    const bool stopped = WaitForTasksToStop(expected);
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        encode_queue_.clear();
        decode_queue_.clear();
        playback_queue_.clear();
        send_queue_.clear();
    }
    if (stopped)
        CloseCodecResources();
}

bool AudioService::Begin(int xiaozhi_codec_volume) {
    if (!started_.load(std::memory_order_relaxed) || !player_)
        return false;
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        encode_queue_.clear();
        decode_queue_.clear();
        playback_queue_.clear();
        send_queue_.clear();
    }
    decode_active_.store(false, std::memory_order_relaxed);
    playback_active_.store(false, std::memory_order_relaxed);
    queue_epoch_.fetch_add(1, std::memory_order_relaxed);
    if (!player_->BeginChat(xiaozhi_codec_volume))
        return false;
    active_.store(true, std::memory_order_relaxed);
    voice_processing_.store(false, std::memory_order_relaxed);
    return true;
}

void AudioService::EndAndRestoreAlbumVolume(int album_level) {
    voice_processing_.store(false, std::memory_order_relaxed);
    const bool was_active = active_.exchange(false, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        encode_queue_.clear();
        decode_queue_.clear();
        playback_queue_.clear();
        send_queue_.clear();
    }
    decode_active_.store(false, std::memory_order_relaxed);
    playback_active_.store(false, std::memory_order_relaxed);
    queue_epoch_.fetch_add(1, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(codec_mutex_);
        if (opus_decoder_)
            esp_opus_dec_reset(opus_decoder_);
        if (output_resampler_)
            esp_ae_rate_cvt_reset(reinterpret_cast<esp_ae_rate_cvt_handle_t>(output_resampler_));
    }
    if (was_active && player_)
        player_->EndChat(vol::ToCodec(album_level));
}

void AudioService::SetVolume(int codec_volume) {
    if (player_ && active_.load(std::memory_order_relaxed))
        player_->SetChatVolume(codec_volume);
}

void AudioService::EnableVoiceProcessing(bool enable) {
    if (enable)
        ResetDecoder();
    voice_processing_.store(enable, std::memory_order_relaxed);
}

bool AudioService::PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket> packet) {
    if (!packet || !active_.load(std::memory_order_relaxed))
        return false;
    packet->epoch = queue_epoch_.load(std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        if (decode_queue_.size() >= kMaxDecodePackets)
            return false;
        decode_queue_.push_back(std::move(packet));
    }
    diag_.decode_push_count.fetch_add(1, std::memory_order_relaxed);
    xSemaphoreGive(decode_notify_);
    return true;
}

void AudioService::ResetDecoder() {
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        decode_queue_.clear();
        playback_queue_.clear();
    }
    decode_active_.store(false, std::memory_order_relaxed);
    playback_active_.store(false, std::memory_order_relaxed);
    queue_epoch_.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(codec_mutex_);
    if (opus_decoder_)
        esp_opus_dec_reset(opus_decoder_);
    if (output_resampler_)
        esp_ae_rate_cvt_reset(reinterpret_cast<esp_ae_rate_cvt_handle_t>(output_resampler_));
}

std::unique_ptr<AudioStreamPacket> AudioService::PopPacketFromSendQueue() {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    if (send_queue_.empty())
        return nullptr;
    auto packet = std::move(send_queue_.front());
    send_queue_.pop_front();
    diag_.send_pop_count.fetch_add(1, std::memory_order_relaxed);
    diag_.last_send_pop_ms.store(time_utils::NowMs(), std::memory_order_relaxed);
    if (decode_notify_)
        xSemaphoreGive(decode_notify_);
    return packet;
}

bool AudioService::IsIdle() {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    return encode_queue_.empty() && decode_queue_.empty() && playback_queue_.empty() && send_queue_.empty() &&
           !decode_active_.load(std::memory_order_relaxed) && !playback_active_.load(std::memory_order_relaxed);
}

bool AudioService::WaitForPlaybackQueueEmpty(int timeout_ms) {
    int waited = 0;
    while (true) {
        bool idle = false;
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            idle = decode_queue_.empty() && playback_queue_.empty() &&
                   !decode_active_.load(std::memory_order_relaxed) && !playback_active_.load(std::memory_order_relaxed);
        }
        if (idle)
            return true;
        if (waited >= timeout_ms)
            return false;
        vTaskDelay(pdMS_TO_TICKS(10));
        waited += 10;
    }
}

void AudioService::InputTaskEntry(void* arg) {
    auto* self = static_cast<AudioService*>(arg);
    self->InputTask();
    self->ClearTaskHandle(xTaskGetCurrentTaskHandle());
    self->SignalTaskStopped();
    vTaskDeleteWithCaps(nullptr);
}

void AudioService::OutputTaskEntry(void* arg) {
    auto* self = static_cast<AudioService*>(arg);
    self->OutputTask();
    self->ClearTaskHandle(xTaskGetCurrentTaskHandle());
    self->SignalTaskStopped();
    vTaskDeleteWithCaps(nullptr);
}

void AudioService::CodecTaskEntry(void* arg) {
    auto* self = static_cast<AudioService*>(arg);
    self->CodecTask();
    self->ClearTaskHandle(xTaskGetCurrentTaskHandle());
    self->SignalTaskStopped();
    vTaskDeleteWithCaps(nullptr);
}

void AudioService::InputTask() {
    std::vector<int16_t> pcm;

    while (started_.load(std::memory_order_relaxed)) {
        if (!active_.load(std::memory_order_relaxed) || !voice_processing_.load(std::memory_order_relaxed) ||
            !player_) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        pcm.resize(encoder_frame_samples_);
        if (!player_->ReadChatPcm(pcm.data(), pcm.size())) {
            diag_.input_read_fail.fetch_add(1, std::memory_order_relaxed);
            const uint32_t fail_count = diag_.input_read_fail.load(std::memory_order_relaxed);
            if (fail_count == 1 || (fail_count % 100) == 0) {
                ESP_LOGW(kTag, "ReadChatPcm failed: active=%d voice=%d fail=%lu ok=%lu",
                         active_.load(std::memory_order_relaxed) ? 1 : 0,
                         voice_processing_.load(std::memory_order_relaxed) ? 1 : 0,
                         static_cast<unsigned long>(fail_count),
                         static_cast<unsigned long>(diag_.input_read_ok.load(std::memory_order_relaxed)));
            }
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        diag_.input_read_ok.fetch_add(1, std::memory_order_relaxed);
        diag_.last_input_ok_ms.store(time_utils::NowMs(), std::memory_order_relaxed);
        int peak = 0;
        for (int16_t sample : pcm) {
            const int value = sample < 0 ? -static_cast<int>(sample) : static_cast<int>(sample);
            if (value > peak)
                peak = value;
        }
        diag_.last_input_peak.store(static_cast<uint32_t>(peak), std::memory_order_relaxed);

        if (!PushTaskToEncodeQueue(std::move(pcm)))
            vTaskDelay(pdMS_TO_TICKS(5));
    }
}

void AudioService::OutputTask() {
    while (started_.load(std::memory_order_relaxed)) {
        std::unique_ptr<PcmTask> task;
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            if (!playback_queue_.empty()) {
                task = std::move(playback_queue_.front());
                playback_queue_.pop_front();
            }
        }
        if (task && decode_notify_)
            xSemaphoreGive(decode_notify_);
        if (!task) {
            if (playback_notify_)
                xSemaphoreTake(playback_notify_, pdMS_TO_TICKS(100));
            continue;
        }
        if (!active_.load(std::memory_order_relaxed) || !player_)
            continue;

        const uint32_t current_epoch = queue_epoch_.load(std::memory_order_relaxed);
        if (task->epoch != current_epoch)
            continue;

        playback_active_.store(true, std::memory_order_relaxed);
        player_->WriteChatPcm(task->pcm.data(), task->pcm.size());
        diag_.playback_write_count.fetch_add(1, std::memory_order_relaxed);
        playback_active_.store(false, std::memory_order_relaxed);
    }
    playback_active_.store(false, std::memory_order_relaxed);
}

void AudioService::CodecTask() {
    while (started_.load(std::memory_order_relaxed)) {
        bool did_work = false;

        std::unique_ptr<AudioStreamPacket> decode_packet;
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            if (!decode_queue_.empty() && playback_queue_.size() < kMaxPlaybackTasks) {
                decode_packet = std::move(decode_queue_.front());
                decode_queue_.pop_front();
            }
        }
        if (decode_packet) {
            did_work = true;
            decode_active_.store(true, std::memory_order_relaxed);
            auto task       = std::make_unique<PcmTask>();
            task->timestamp = decode_packet->timestamp;
            task->epoch     = decode_packet->epoch;

            bool decoded = false;
            {
                std::lock_guard<std::mutex> lock(codec_mutex_);
                if (EnsureDecoderLocked(decode_packet->sample_rate, decode_packet->frame_duration)) {
                    task->pcm.resize(decoder_frame_samples_);
                    esp_audio_dec_in_raw_t raw = {
                        .buffer        = decode_packet->payload.data(),
                        .len           = static_cast<uint32_t>(decode_packet->payload.size()),
                        .consumed      = 0,
                        .frame_recover = ESP_AUDIO_DEC_RECOVERY_NONE,
                    };
                    esp_audio_dec_out_frame_t frame = {
                        .buffer       = reinterpret_cast<uint8_t*>(task->pcm.data()),
                        .len          = static_cast<uint32_t>(task->pcm.size() * sizeof(int16_t)),
                        .needed_size  = 0,
                        .decoded_size = 0,
                    };
                    esp_audio_dec_info_t info = {};
                    auto                 ret  = esp_opus_dec_decode(opus_decoder_, &raw, &frame, &info);
                    if (ret != ESP_AUDIO_ERR_OK || frame.decoded_size == 0) {
                        ESP_LOGW(kTag, "Decode failed: %d", ret);
                    } else {
                        task->pcm.resize(frame.decoded_size / sizeof(int16_t));
                        decoded = ResampleToDeviceRateLocked(task->pcm, decode_packet->sample_rate);
                    }
                }
            }
            if (decoded && !task->pcm.empty()) {
                {
                    std::lock_guard<std::mutex> lock(queue_mutex_);
                    if (task->epoch == queue_epoch_.load(std::memory_order_relaxed) &&
                        playback_queue_.size() < kMaxPlaybackTasks) {
                        playback_queue_.push_back(std::move(task));
                    }
                }
                if (playback_notify_)
                    xSemaphoreGive(playback_notify_);
            }
            decode_active_.store(false, std::memory_order_relaxed);
        }

        std::unique_ptr<PcmTask> encode_task;
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            if (!encode_queue_.empty() && send_queue_.size() < kMaxSendPackets) {
                encode_task = std::move(encode_queue_.front());
                encode_queue_.pop_front();
            }
        }
        if (encode_task) {
            did_work = true;
            if (encode_task->pcm.size() != static_cast<size_t>(encoder_frame_samples_)) {
                ESP_LOGW(kTag, "Skip encode: invalid frame samples=%u expected=%d",
                         static_cast<unsigned>(encode_task->pcm.size()), encoder_frame_samples_);
                diag_.encode_fail.fetch_add(1, std::memory_order_relaxed);
            } else {
                std::vector<uint8_t>     encoded(encoder_output_bytes_);
                esp_audio_enc_in_frame_t in = {
                    .buffer = reinterpret_cast<uint8_t*>(encode_task->pcm.data()),
                    .len    = static_cast<uint32_t>(encode_task->pcm.size() * sizeof(int16_t)),
                };
                esp_audio_enc_out_frame_t out = {};
                out.buffer                    = encoded.data();
                out.len                       = static_cast<uint32_t>(encoded.size());
                out.encoded_bytes             = 0;
                auto ret                      = esp_opus_enc_process(opus_encoder_, &in, &out);
                if (ret == ESP_AUDIO_ERR_OK && out.encoded_bytes == 0) {
                    diag_.encode_empty.fetch_add(1, std::memory_order_relaxed);
                } else if (ret != ESP_AUDIO_ERR_OK) {
                    diag_.encode_fail.fetch_add(1, std::memory_order_relaxed);
                    ESP_LOGW(kTag, "Encode failed: %d", ret);
                } else {
                    diag_.encode_ok.fetch_add(1, std::memory_order_relaxed);
                    diag_.last_encode_ok_ms.store(time_utils::NowMs(), std::memory_order_relaxed);
                    auto packet            = std::make_unique<AudioStreamPacket>();
                    packet->sample_rate    = kClientSampleRate;
                    packet->frame_duration = kOpusFrameDurationMs;
                    packet->timestamp      = encode_task->timestamp;
                    packet->epoch          = encode_task->epoch;
                    packet->payload.assign(encoded.data(), encoded.data() + out.encoded_bytes);
                    {
                        std::lock_guard<std::mutex> lock(queue_mutex_);
                        if (packet->epoch == queue_epoch_.load(std::memory_order_relaxed))
                            send_queue_.push_back(std::move(packet));
                    }
                    if (send_notify_)
                        xSemaphoreGive(send_notify_);
                }
            }
        }

        if (!did_work && decode_notify_)
            xSemaphoreTake(decode_notify_, pdMS_TO_TICKS(kCodecTaskDelayMs));
    }
    decode_active_.store(false, std::memory_order_relaxed);
}

bool AudioService::PushTaskToEncodeQueue(std::vector<int16_t>&& pcm) {
    if (pcm.empty() || !active_.load(std::memory_order_relaxed))
        return false;

    while (started_.load(std::memory_order_relaxed) && active_.load(std::memory_order_relaxed) &&
           voice_processing_.load(std::memory_order_relaxed)) {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            if (encode_queue_.size() < kMaxEncodeTasks) {
                auto task   = std::make_unique<PcmTask>();
                task->pcm   = std::move(pcm);
                task->epoch = queue_epoch_.load(std::memory_order_relaxed);
                encode_queue_.push_back(std::move(task));
                if (decode_notify_)
                    xSemaphoreGive(decode_notify_);
                return true;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return false;
}

bool AudioService::EnsureDecoderLocked(int sample_rate, int frame_duration) {
    if (sample_rate <= 0)
        sample_rate = kClientSampleRate;
    if (frame_duration <= 0)
        frame_duration = kOpusFrameDurationMs;
    if (!IsSupportedOpusSampleRate(sample_rate)) {
        ESP_LOGW(kTag, "Reject decoder sample rate: %d", sample_rate);
        return false;
    }
    if (!IsSupportedOpusFrameDuration(frame_duration)) {
        ESP_LOGW(kTag, "Reject decoder frame duration: %d", frame_duration);
        return false;
    }
    if (opus_decoder_ && decoder_sample_rate_ == sample_rate && decoder_frame_duration_ == frame_duration)
        return true;

    if (opus_decoder_) {
        esp_opus_dec_close(opus_decoder_);
        opus_decoder_ = nullptr;
    }
    if (output_resampler_) {
        esp_ae_rate_cvt_close(output_resampler_);
        output_resampler_ = nullptr;
    }
    decoder_sample_rate_    = 0;
    decoder_frame_duration_ = 0;
    decoder_frame_samples_  = 0;

    esp_opus_dec_cfg_t dec_cfg = {
        .sample_rate    = static_cast<uint32_t>(sample_rate),
        .channel        = ESP_AUDIO_MONO,
        .frame_duration = DecDurationEnum(frame_duration),
        .self_delimited = false,
    };
    auto ret = esp_opus_dec_open(&dec_cfg, sizeof(dec_cfg), &opus_decoder_);
    if (ret != ESP_AUDIO_ERR_OK || !opus_decoder_) {
        ESP_LOGE(kTag, "Failed to create decoder: %d", ret);
        if (opus_decoder_)
            esp_opus_dec_close(opus_decoder_);
        opus_decoder_ = nullptr;
        return false;
    }

    decoder_sample_rate_    = sample_rate;
    decoder_frame_duration_ = frame_duration;
    decoder_frame_samples_  = sample_rate * frame_duration / 1000;
    if (sample_rate != kClientSampleRate) {
        esp_ae_rate_cvt_cfg_t cfg = {
            .src_rate        = static_cast<uint32_t>(sample_rate),
            .dest_rate       = ESP_AUDIO_SAMPLE_RATE_16K,
            .channel         = ESP_AUDIO_MONO,
            .bits_per_sample = ESP_AUDIO_BIT16,
            .complexity      = 2,
            .perf_type       = ESP_AE_RATE_CVT_PERF_TYPE_SPEED,
        };
        auto cvt_ret = esp_ae_rate_cvt_open(&cfg, reinterpret_cast<esp_ae_rate_cvt_handle_t*>(&output_resampler_));
        if (cvt_ret != ESP_AE_ERR_OK || !output_resampler_) {
            ESP_LOGE(kTag, "Failed to create output resampler: %d", cvt_ret);
            if (output_resampler_)
                esp_ae_rate_cvt_close(output_resampler_);
            esp_opus_dec_close(opus_decoder_);
            opus_decoder_           = nullptr;
            output_resampler_       = nullptr;
            decoder_sample_rate_    = 0;
            decoder_frame_duration_ = 0;
            decoder_frame_samples_  = 0;
            return false;
        }
    }
    return true;
}

bool AudioService::ResampleToDeviceRateLocked(std::vector<int16_t>& pcm, int sample_rate) {
    if (sample_rate == kClientSampleRate || !output_resampler_)
        return true;
    uint32_t max_out = 0;
    auto     ret     = esp_ae_rate_cvt_get_max_out_sample_num(output_resampler_, pcm.size(), &max_out);
    if (ret != ESP_AE_ERR_OK || max_out == 0)
        return false;
    std::vector<int16_t> out(max_out);
    uint32_t             actual = max_out;
    ret = esp_ae_rate_cvt_process(output_resampler_, reinterpret_cast<esp_ae_sample_t>(pcm.data()), pcm.size(),
                                  reinterpret_cast<esp_ae_sample_t>(out.data()), &actual);
    if (ret != ESP_AE_ERR_OK)
        return false;
    out.resize(actual);
    pcm = std::move(out);
    return true;
}

void AudioService::CloseCodecResources() {
    std::lock_guard<std::mutex> lock(codec_mutex_);
    if (opus_encoder_) {
        esp_opus_enc_close(opus_encoder_);
        opus_encoder_ = nullptr;
    }
    if (opus_decoder_) {
        esp_opus_dec_close(opus_decoder_);
        opus_decoder_ = nullptr;
    }
    if (output_resampler_) {
        esp_ae_rate_cvt_close(output_resampler_);
        output_resampler_ = nullptr;
    }
    encoder_frame_samples_  = 0;
    encoder_input_bytes_    = 0;
    encoder_output_bytes_   = 0;
    decoder_sample_rate_    = 0;
    decoder_frame_duration_ = 0;
    decoder_frame_samples_  = 0;
}

void AudioService::ClearTaskHandle(TaskHandle_t current) {
    std::lock_guard<std::mutex> task_lock(task_mutex_);
    if (input_task_ == current)
        input_task_ = nullptr;
    if (output_task_ == current)
        output_task_ = nullptr;
    if (codec_task_ == current)
        codec_task_ = nullptr;
}

void AudioService::SignalTaskStopped() {
    if (task_done_notify_)
        xSemaphoreGive(task_done_notify_);
}

bool AudioService::WaitForTasksToStop(int expected_count) {
    for (int i = 0; i < expected_count; ++i) {
        if (!task_done_notify_)
            return false;
        if (xSemaphoreTake(task_done_notify_, pdMS_TO_TICKS(1000)) != pdTRUE) {
            ESP_LOGW(kTag, "Timed out waiting for audio task %d/%d", i + 1, expected_count);
            return false;
        }
    }
    return true;
}

}  // namespace xiaozhi
