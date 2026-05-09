#pragma once

// I2S + ES8311 audio playback。单例,异步播放:Play(buf, samples) 替换共享
// PCM buf + notify task,task 内 esp_codec_dev_write 阻塞写一段后释放。
//
// 服务端约定:16kHz mono 16-bit raw PCM(.pcm 二进制)。
// 数据来源:cache::ReadFrameAudio(gid, idx, vec<uint8_t>) 读 LittleFS。
// frame 切换时调 Play() 中断当前播放,立即播新 PCM。
//
// 抄袭 esp32-eink/refs/zectrix-original/main/audio/codecs/es8311_audio_codec.cc 的
// I2S+ES8311 配置序列(去 AudioCodec 父类继承,只保留 output 部分,不要 mic)。

#include <cstdint>
#include <cstddef>

#include <driver/i2c_master.h>
#include <driver/i2s_std.h>
#include <esp_codec_dev.h>
#include <esp_codec_dev_defaults.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

class AudioPlayer {
   public:
    static AudioPlayer& Get();

    // 一次性初始化 I2S + codec。需 Board::I2c() 已 ready,sample_rate 16000。
    // 失败返回 false(I2C 通讯失败/codec 未识别等)。
    bool Init(i2c_master_bus_handle_t i2c_bus);

    // 异步播放:替换共享 PCM,通知 task 立即播。中断当前播放(若有)。
    // pcm = 16kHz mono 16-bit signed,len_bytes 必须是偶数。
    void Play(const uint8_t* pcm_bytes, size_t len_bytes);

    // 停止当前播放(若有);保持 codec 通电,下次 Play 立即可用。
    void Stop();

    // 0..100,默认 70。改 codec output volume 寄存器。
    void SetVolume(int v);

   private:
    AudioPlayer() = default;
    static void TaskEntry(void* arg);
    void        TaskLoop();

    bool                          initialized_ = false;
    i2s_chan_handle_t             tx_handle_   = nullptr;
    const audio_codec_data_if_t*  data_if_     = nullptr;
    const audio_codec_ctrl_if_t*  ctrl_if_     = nullptr;
    const audio_codec_if_t*       codec_if_    = nullptr;
    const audio_codec_gpio_if_t*  gpio_if_     = nullptr;
    esp_codec_dev_handle_t        dev_         = nullptr;
    int                  volume_      = 85;

    // 共享 PCM:Play 写入,task 读取并播。简单 swap,不做 ring buffer
    // (本场景 frame 切换 = 整段重播,不是流式追加)。
    SemaphoreHandle_t  shared_mutex_ = nullptr;
    SemaphoreHandle_t  notify_       = nullptr;  // binary semaphore,Play 时 give,task wait
    uint8_t*           pending_pcm_  = nullptr;  // 由 Play 拷贝;task 取走置 null
    size_t             pending_len_  = 0;
    volatile bool      stop_flag_    = false;
    TaskHandle_t       task_         = nullptr;
};
