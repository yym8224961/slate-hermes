#pragma once

// I2S + ES8311 audio owner。内容使用异步播放接口；小智进入对话时通过
// BeginChat/EndChat 独占同一套 codec/I2S，避免两套业务各自初始化硬件。
//
// 服务端约定：16 kHz mono 16-bit raw PCM（.pcm 二进制）。
// 数据来源:cache::ReadFrameAudio(gid, idx, vec<uint8_t>) 读 LittleFS。
// frame 切换时调 Play() 中断当前播放,立即播新 PCM。
//
// 抄袭 esp32-eink/refs/zectrix-original/main/audio/codecs/es8311_audio_codec.cc 的
// I2S+ES8311 配置序列(去 AudioCodec 父类继承,只保留 output 部分,不要 mic)。

#include <cstddef>
#include <cstdint>

#include <driver/i2c_master.h>
#include <driver/i2s_std.h>
#include <esp_codec_dev.h>
#include <esp_codec_dev_defaults.h>
#include <esp_pm.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>

class AudioPlayer {
   public:
    static AudioPlayer& Get();

    // 一次性初始化 I2S + codec。需 Board::I2c() 已 ready,sample_rate 16000。
    // 失败返回 false(I2C 通讯失败/codec 未识别等)。
    bool Init(i2c_master_bus_handle_t i2c_bus);

    // 异步播放：替换共享 PCM，通知 task 立即播。中断当前播放（若有）。
    // pcm = 16 kHz mono 16-bit signed，len_bytes 必须是偶数。
    void Play(const uint8_t* pcm_bytes, size_t len_bytes);

    // 停止当前播放(若有);保持 codec 通电,下次 Play 立即可用。
    void Stop();

    // 0..100,默认 90。改 codec output volume 寄存器。
    void SetVolume(int v);

    // 小智对话独占音频硬件。
    bool BeginChat();
    void EndChat();
    bool ReadChatPcm(int16_t* dest, size_t samples);
    bool WriteChatPcm(const int16_t* data, size_t samples);
    bool IsChatActive() const {
        return chat_active_.load(std::memory_order_relaxed);
    }

   private:
    AudioPlayer() = default;
    static void TaskEntry(void* arg);
    void        TaskLoop();
    // 第一次 Play 时同步打开 codec(lazy)。开机不 open 是为了消除 codec lib
    // 的 enable→DAC start→PA on 时序在喇叭上的"啵"声。
    bool EnsureCodecOpen();
    void CleanupInitResources();
    // 音频活跃期持有 NO_LIGHT_SLEEP 锁，防止自动 light sleep 停时钟导致 I2S 欠载卡顿。
    // acquire/release 必须配对；内部判空，PM 锁创建失败时为 no-op。
    void AcquireAudioPmLock();
    void ReleaseAudioPmLock();

    bool              initialized_ = false;
    std::atomic<bool> codec_opened_{false};  // lazy 标志
    // 是否已经播过至少一段 PCM。用于 TaskLoop 判断"切歌"场景需要先静音再写,
    // 避免旧 PCM 末尾和新 PCM 开头波形跳变产生"啵"。Init 后第一段不算切歌。
    std::atomic<bool>            codec_in_progress_{false};
    i2s_chan_handle_t            tx_handle_ = nullptr;
    i2s_chan_handle_t            rx_handle_ = nullptr;
    const audio_codec_data_if_t* data_if_   = nullptr;
    const audio_codec_ctrl_if_t* ctrl_if_   = nullptr;
    const audio_codec_if_t*      codec_if_  = nullptr;
    const audio_codec_gpio_if_t* gpio_if_   = nullptr;
    esp_codec_dev_handle_t       dev_       = nullptr;
    std::atomic<int>             volume_{90};

    // 共享 PCM:Play 写入,task 读取并播。简单 swap,不做 ring buffer
    // (本场景 frame 切换 = 整段重播,不是流式追加)。
    SemaphoreHandle_t shared_mutex_ = nullptr;
    SemaphoreHandle_t codec_mutex_  = nullptr;
    SemaphoreHandle_t notify_       = nullptr;  // binary semaphore,Play 时 give,task wait
    uint8_t*          pending_pcm_  = nullptr;  // 由 Play 拷贝;task 取走置 null
    size_t            pending_len_  = 0;
    std::atomic<bool> stop_flag_{false};
    std::atomic<bool> chat_active_{false};
    TaskHandle_t      task_ = nullptr;

    esp_pm_lock_handle_t no_light_sleep_lock_ = nullptr;
};
