#include "drivers/audio/audio_player.h"

#include <driver/gpio.h>
#include <esp_codec_dev_defaults.h>
#include <esp_log.h>
#include <esp_log_level.h>

#include <cstdlib>
#include <cstring>

#include "bsp/config.h"
#include "drivers/bus/i2c_bus_lock.h"
#include "storage/nvs/volume_store.h"
#include "utils/gpio_util.h"

// Board::Init 已经在 InitPower 阶段把 GPIO42（AVDD_3V3 rail）拉高 + hold_en。
// i2c_device.cc 仍然在异常路径上调 BoardI2cForcePowerOn 自救，实现放在 board_power.cc。

namespace {
constexpr char kTag[] = "audio";
}

AudioPlayer& AudioPlayer::Get() {
    static AudioPlayer p;
    return p;
}

bool AudioPlayer::Init(i2c_master_bus_handle_t i2c_bus) {
    if (initialized_)
        return true;
    auto fail = [this]() {
        CleanupInitResources();
        return false;
    };

    // ── I2S0 master duplex 16 kHz mono 16-bit。内容只用 TX；小智对话进入时
    // 使用同一套 RX/TX，避免重复创建 I2S0 channel。
    i2s_chan_config_t chan_cfg = {};
    chan_cfg.id                = I2S_NUM_0;
    chan_cfg.role              = I2S_ROLE_MASTER;
    chan_cfg.dma_desc_num      = 6;
    chan_cfg.dma_frame_num     = 240;
    // auto_clear_after_cb: 没数据时 DMA 自动填零,避免空闲喇叭啸叫。
    // (老代码用 .auto_clear,IDF 5.4+ 已 deprecated 改为 alias)
    chan_cfg.auto_clear_after_cb = true;
    chan_cfg.intr_priority       = 0;
    esp_err_t err                = i2s_new_channel(&chan_cfg, &tx_handle_, &rx_handle_);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "i2s channel create failed err=%s", esp_err_to_name(err));
        return fail();
    }

    i2s_std_config_t std_cfg        = {};
    std_cfg.clk_cfg.sample_rate_hz  = AUDIO_OUTPUT_SAMPLE_RATE;
    std_cfg.clk_cfg.clk_src         = I2S_CLK_SRC_DEFAULT;
    std_cfg.clk_cfg.mclk_multiple   = I2S_MCLK_MULTIPLE_256;
    std_cfg.slot_cfg.data_bit_width = I2S_DATA_BIT_WIDTH_16BIT;
    std_cfg.slot_cfg.slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO;
    // 单声道:数据按 left-only 输出。喇叭只一个,STEREO 模式下每采样发两遍
    // 浪费一半 DMA 带宽且 ES8311 寄存器要 stereo→mono 二次配置才正确出声。
    std_cfg.slot_cfg.slot_mode = I2S_SLOT_MODE_MONO;
    std_cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
    std_cfg.slot_cfg.ws_width  = I2S_DATA_BIT_WIDTH_16BIT;
    std_cfg.slot_cfg.ws_pol    = false;
    std_cfg.slot_cfg.bit_shift = true;
#ifdef I2S_HW_VERSION_2
    std_cfg.slot_cfg.left_align    = true;
    std_cfg.slot_cfg.big_endian    = false;
    std_cfg.slot_cfg.bit_order_lsb = false;
#endif
    std_cfg.gpio_cfg.mclk = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_MCLK);
    std_cfg.gpio_cfg.bclk = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_BCLK);
    std_cfg.gpio_cfg.ws   = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_WS);
    std_cfg.gpio_cfg.dout = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_DOUT);
    std_cfg.gpio_cfg.din  = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_DIN);
    err                   = i2s_channel_init_std_mode(tx_handle_, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "i2s tx init failed err=%s", esp_err_to_name(err));
        return fail();
    }
    err = i2s_channel_init_std_mode(rx_handle_, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "i2s rx init failed err=%s", esp_err_to_name(err));
        return fail();
    }
    // 不在这里 i2s_channel_enable:esp_codec_dev_open 内部会 enable channel,
    // 早 enable 反而触发 codec lib 一条 "channel has not been enabled yet"
    // E 级 log(它 enable 前会先尝试 disable 一个 INIT 状态的 channel),
    // 无害但污染 log。

    // ── ES8311 codec 配置:仅 DAC 输出。ADC/MIC 路径不上电,省功耗 ──
    audio_codec_i2s_cfg_t i2s_data_cfg = {};
    i2s_data_cfg.port                  = I2S_NUM_0;
    i2s_data_cfg.tx_handle             = tx_handle_;
    i2s_data_cfg.rx_handle             = rx_handle_;
    data_if_                           = audio_codec_new_i2s_data(&i2s_data_cfg);
    if (!data_if_) {
        ESP_LOGE(kTag, "codec data interface create failed");
        return fail();
    }

    audio_codec_i2c_cfg_t i2c_cfg = {};
    i2c_cfg.port                  = I2C_NUM_0;
    i2c_cfg.addr                  = AUDIO_CODEC_ES8311_ADDR;
    i2c_cfg.bus_handle            = i2c_bus;
    {
        ScopedI2cBusLock lock("AudioPlayer::Init");
        ESP_ERROR_CHECK(lock.status());
        ctrl_if_ = audio_codec_new_i2c_ctrl(&i2c_cfg);
    }
    if (!ctrl_if_) {
        ESP_LOGE(kTag, "codec control interface create failed");
        return fail();
    }

    gpio_if_ = audio_codec_new_gpio();
    if (!gpio_if_) {
        ESP_LOGE(kTag, "codec gpio interface create failed");
        return fail();
    }

    // PA pin 自管:codec lib 默认在 enable(true) 内 DAC start → pa_power(ENABLE)
    // → set_mute(false),三步紧挨,DAC 还没稳到零 PA 就上电了 → 喇叭"啵"。
    // 这里 pa_pin=-1 让 codec lib 完全不动 PA;EnsureCodecOpen 内自己控时序:
    //   codec_dev_open（DAC start，但 PA 仍 LOW 不出声）→ 等 100 ms DAC 稳定 → 拉高 PA。
    // PA pin 的 OUTPUT + LOW + hold_en 已由 BoardPowerBsp 在最早的 InitPower 阶段
    // 完成,先于 PowerAudioOn 给 PA U5 通电 —— 这是消除开机"啵"声的根本时序点。

    es8311_codec_cfg_t es_cfg        = {};
    es_cfg.ctrl_if                   = ctrl_if_;
    es_cfg.gpio_if                   = gpio_if_;
    es_cfg.codec_mode                = ESP_CODEC_DEV_WORK_MODE_BOTH;
    es_cfg.pa_pin                    = -1;  // 自管(见上方注释)
    es_cfg.use_mclk                  = true;
    es_cfg.hw_gain.pa_voltage        = 5.0;
    es_cfg.hw_gain.codec_dac_voltage = 3.3;
    es_cfg.pa_reverted               = false;
    codec_if_                        = es8311_codec_new(&es_cfg);
    if (!codec_if_) {
        ESP_LOGE(kTag, "codec create failed chip=es8311");
        return fail();
    }

    // 创建 codec dev handle,但不 open。Lazy 模式:第一次 Play 时才
    // esp_codec_dev_open(codec lib 内部 DAC start;pa_pin=-1 所以不动 PA)。
    // PA 由 EnsureCodecOpen 在 codec_dev_open + 100 ms DAC 稳定窗后自管拉高，
    // 此时 DAC bias 已收敛到 0,放大也听不到"啵"。
    // 参考 zectrix-original/main/audio/codecs/es8311_audio_codec.cc 的 lazy
    // UpdateDeviceState 模式。
    esp_codec_dev_cfg_t dev_cfg = {};
    dev_cfg.dev_type            = ESP_CODEC_DEV_TYPE_IN_OUT;
    dev_cfg.codec_if            = codec_if_;
    dev_cfg.data_if             = data_if_;
    dev_                        = esp_codec_dev_new(&dev_cfg);
    if (!dev_) {
        ESP_LOGE(kTag, "codec device create failed");
        return fail();
    }

    // 后台 task 等通知,有 PCM 时阻塞写
    shared_mutex_ = xSemaphoreCreateMutex();
    codec_mutex_  = xSemaphoreCreateMutex();
    notify_       = xSemaphoreCreateBinary();
    if (!shared_mutex_ || !codec_mutex_ || !notify_) {
        ESP_LOGE(kTag, "sync primitive create failed");
        return fail();
    }
    BaseType_t task_ok = xTaskCreatePinnedToCore(&AudioPlayer::TaskEntry, "audio_play", 6 * 1024, this, 5, &task_, 1);
    if (task_ok != pdPASS) {
        ESP_LOGE(kTag, "task create failed name=audio_play");
        return fail();
    }

    // 仅缓存音量,首次 Lazy open 后再 set 到 codec。放在同步原语创建之后，
    // 即使 Init 中途失败，未初始化实例的默认值也保持与 volume_store 默认值一致。
    volume_.store(vol::ToCodec(vol::Get()), std::memory_order_relaxed);

    // NO_LIGHT_SLEEP 锁:播放/对话期间持有,防止自动 light sleep 停时钟使 I2S DMA 欠载
    // 而卡顿。创建失败不致命(退化为无锁,等价旧行为),acquire/release 内部判空。
    esp_err_t pm_err = esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "audio", &no_light_sleep_lock_);
    if (pm_err != ESP_OK) {
        ESP_LOGW(kTag, "pm lock create failed err=%s", esp_err_to_name(pm_err));
        no_light_sleep_lock_ = nullptr;
    }

    initialized_ = true;
    return true;
}

void AudioPlayer::AcquireAudioPmLock() {
    if (no_light_sleep_lock_)
        esp_pm_lock_acquire(no_light_sleep_lock_);
}

void AudioPlayer::ReleaseAudioPmLock() {
    if (no_light_sleep_lock_)
        esp_pm_lock_release(no_light_sleep_lock_);
}

void AudioPlayer::CleanupInitResources() {
    if (dev_) {
        esp_codec_dev_delete(dev_);
        dev_ = nullptr;
    }
    if (codec_if_) {
        audio_codec_delete_codec_if(codec_if_);
        codec_if_ = nullptr;
    }
    if (gpio_if_) {
        audio_codec_delete_gpio_if(gpio_if_);
        gpio_if_ = nullptr;
    }
    if (ctrl_if_) {
        audio_codec_delete_ctrl_if(ctrl_if_);
        ctrl_if_ = nullptr;
    }
    if (data_if_) {
        audio_codec_delete_data_if(data_if_);
        data_if_ = nullptr;
    }
    if (tx_handle_) {
        i2s_del_channel(tx_handle_);
        tx_handle_ = nullptr;
    }
    if (rx_handle_) {
        i2s_del_channel(rx_handle_);
        rx_handle_ = nullptr;
    }
    if (shared_mutex_) {
        vSemaphoreDelete(shared_mutex_);
        shared_mutex_ = nullptr;
    }
    if (codec_mutex_) {
        vSemaphoreDelete(codec_mutex_);
        codec_mutex_ = nullptr;
    }
    if (notify_) {
        vSemaphoreDelete(notify_);
        notify_ = nullptr;
    }
    codec_opened_.store(false, std::memory_order_release);
    codec_in_progress_.store(false, std::memory_order_release);
}

bool AudioPlayer::EnsureCodecOpen() {
    if (codec_opened_.load(std::memory_order_acquire))
        return true;
    esp_codec_dev_sample_info_t fs = {};
    fs.bits_per_sample             = 16;
    fs.channel                     = 1;
    fs.channel_mask                = 0;
    fs.sample_rate                 = AUDIO_OUTPUT_SAMPLE_RATE;
    fs.mclk_multiple               = 0;
    xSemaphoreTake(codec_mutex_, portMAX_DELAY);
    if (codec_opened_.load(std::memory_order_relaxed)) {
        xSemaphoreGive(codec_mutex_);
        return true;
    }
    {
        ScopedI2cBusLock lock("AudioPlayer::lazy_open");
        if (lock.status() != ESP_OK) {
            xSemaphoreGive(codec_mutex_);
            return false;
        }
        // PA 此时仍 LOW(BoardPowerBsp 构造已设 + hold_en),不出声。codec_dev_open
        // 内 codec lib 会 DAC start + set_mute(false),但 pa_pin=-1 所以不动 PA。
        //
        // esp_codec_dev 1.5.x 的 I2S data_if 在 set_fmt 阶段会先 disable
        // 尚未 enable 的 TX/RX channel。ESP-IDF driver 会打一条 i2s_common
        // ERROR,但随后 open 成功。只在这次已知调用窗口里压掉 false error。
        const esp_log_level_t i2s_common_level = esp_log_level_get("i2s_common");
        esp_log_level_set("i2s_common", ESP_LOG_NONE);
        if (esp_codec_dev_open(dev_, &fs) != ESP_OK) {
            esp_log_level_set("i2s_common", i2s_common_level);
            ESP_LOGE(kTag, "codec device open failed");
            xSemaphoreGive(codec_mutex_);
            return false;
        }
        esp_log_level_set("i2s_common", i2s_common_level);
        esp_codec_dev_set_out_vol(dev_, volume_.load(std::memory_order_relaxed));
        esp_codec_dev_set_in_gain(dev_, 30.0f);
        // codec_opened_=true 必须在锁内,否则 SetVolume 在锁外释放后到这里之间
        // 看到 codec_opened_=false 只缓存,不调 set_out_vol,音量同步丢失。
        codec_opened_.store(true, std::memory_order_release);
    }
    xSemaphoreGive(codec_mutex_);
    // 等 DAC DC bias 稳定到零再上 PA，消除「啵」。100 ms 是经验值：ES8311 上电
    // 后前 ~50 ms DC 输出有 mV 级跳动，稳定后再放大就听不到啵了。
    vTaskDelay(pdMS_TO_TICKS(100));
    // PA pin 在 BoardPowerBsp 构造时打了 hold_en,GpioWriteHold 内部包了
    // hold_dis → set_level → hold_en 三段式,跟 Power*On/Off 用法一致。
    GpioWriteHold(AUDIO_CODEC_PA_PIN, 1);
    return true;
}

void AudioPlayer::Play(const uint8_t* pcm_bytes, size_t len_bytes) {
    if (!initialized_ || pcm_bytes == nullptr || len_bytes == 0)
        return;
    if (xiaozhi_active_.load(std::memory_order_relaxed))
        return;
    if (len_bytes & 1)
        len_bytes &= ~1;  // 取偶,16bit 对齐
    if (len_bytes == 0)
        return;

    // 深拷贝(LittleFS 缓冲生命周期短),共享 mutex 保护
    uint8_t* copy = static_cast<uint8_t*>(malloc(len_bytes));
    if (!copy) {
        ESP_LOGW(kTag, "play alloc failed bytes=%u", (unsigned)len_bytes);
        return;
    }
    std::memcpy(copy, pcm_bytes, len_bytes);

    xSemaphoreTake(shared_mutex_, portMAX_DELAY);
    if (pending_pcm_)
        free(pending_pcm_);
    pending_pcm_ = copy;
    pending_len_ = len_bytes;
    stop_flag_.store(true, std::memory_order_release);  // 中断当前播放
    xSemaphoreGive(shared_mutex_);
    xSemaphoreGive(notify_);
}

void AudioPlayer::Stop() {
    if (!initialized_)
        return;
    xSemaphoreTake(shared_mutex_, portMAX_DELAY);
    if (pending_pcm_) {
        free(pending_pcm_);
        pending_pcm_ = nullptr;
        pending_len_ = 0;
    }
    stop_flag_.store(true, std::memory_order_release);
    xSemaphoreGive(shared_mutex_);
    if (notify_)
        xSemaphoreGive(notify_);
}

void AudioPlayer::SetVolume(int v) {
    if (v < 0)
        v = 0;
    if (v > 100)
        v = 100;
    volume_.store(v, std::memory_order_relaxed);
    // Codec 还没 lazy open 就只更新缓存,首次 open 时一并 set。
    if (dev_ && codec_opened_.load(std::memory_order_acquire)) {
        xSemaphoreTake(codec_mutex_, portMAX_DELAY);
        ScopedI2cBusLock lock("AudioPlayer::SetVolume");
        if (lock.status() == ESP_OK) {
            esp_codec_dev_set_out_vol(dev_, volume_.load(std::memory_order_relaxed));
        }
        xSemaphoreGive(codec_mutex_);
    }
}

bool AudioPlayer::BeginXiaozhi() {
    if (!initialized_)
        return false;
    Stop();
    xiaozhi_active_.store(true, std::memory_order_relaxed);
    if (!EnsureCodecOpen()) {
        xiaozhi_active_.store(false, std::memory_order_relaxed);
        return false;
    }
    // 对话期间(双工 I2S)禁 light sleep；与 EndXiaozhi 的 release 配对(由 xiaozhi_active_ 守卫)。
    AcquireAudioPmLock();
    return true;
}

void AudioPlayer::EndXiaozhi() {
    if (!initialized_)
        return;
    const bool was_active = xiaozhi_active_.exchange(false, std::memory_order_relaxed);
    if (was_active)
        ReleaseAudioPmLock();
}

bool AudioPlayer::ReadXiaozhiPcm(int16_t* dest, size_t samples) {
    if (!initialized_ || !xiaozhi_active_.load(std::memory_order_relaxed) || !dest || samples == 0)
        return false;
    if (!EnsureCodecOpen())
        return false;
    xSemaphoreTake(codec_mutex_, portMAX_DELAY);
    const int ret = esp_codec_dev_read(dev_, dest, static_cast<int>(samples * sizeof(int16_t)));
    xSemaphoreGive(codec_mutex_);
    return ret == ESP_OK;
}

bool AudioPlayer::WriteXiaozhiPcm(const int16_t* data, size_t samples) {
    if (!initialized_ || !xiaozhi_active_.load(std::memory_order_relaxed) || !data || samples == 0)
        return false;
    if (!EnsureCodecOpen())
        return false;
    xSemaphoreTake(codec_mutex_, portMAX_DELAY);
    // esp_audio_codec 的 C API 没有 const-correct；当前 ES8311 write path 不会修改输入 PCM。
    const int ret = esp_codec_dev_write(dev_, const_cast<int16_t*>(data), static_cast<int>(samples * sizeof(int16_t)));
    xSemaphoreGive(codec_mutex_);
    return ret == ESP_OK;
}

void AudioPlayer::TaskEntry(void* arg) {
    static_cast<AudioPlayer*>(arg)->TaskLoop();
    vTaskDelete(nullptr);
}

void AudioPlayer::TaskLoop() {
    // 256 B/chunk = 8 ms@16 kHz mono16：stop_flag 检查粒度更细，切歌响应更及时。
    // 配合切歌前 set_out_vol(0) + 20 ms 数字静音衔接，人耳基本听不到“啵”。
    constexpr size_t kChunk = 256;
    while (true) {
        // 等通知
        xSemaphoreTake(notify_, portMAX_DELAY);
        if (xiaozhi_active_.load(std::memory_order_relaxed))
            continue;

        // 拿当前 pending
        xSemaphoreTake(shared_mutex_, portMAX_DELAY);
        uint8_t* buf = pending_pcm_;
        size_t   len = pending_len_;
        pending_pcm_ = nullptr;
        pending_len_ = 0;
        stop_flag_.store(false, std::memory_order_release);
        xSemaphoreGive(shared_mutex_);

        if (!buf || len == 0)
            continue;
        if (xiaozhi_active_.load(std::memory_order_relaxed)) {
            free(buf);
            continue;
        }

        // 第一次播放才真正打开 codec(lazy)。Init 时不 open,目的是开机不出"啵"。
        // EnsureCodecOpen 内做完整时序：open → 等 100 ms DAC 稳定 → 拉高 PA。
        if (!EnsureCodecOpen()) {
            free(buf);
            continue;
        }

        // 本段播放期间禁 light sleep（与下方 free(buf) 后的 release 配对）。
        AcquireAudioPmLock();

        // 中断当前播放后，直接接续写新 PCM 会“啵”：旧 PCM 最后样本和新 PCM 第一
        // 样本之间 DC 跳变，被 PA 直接放大。先 set_out_vol(0) 数字静音，等 DAC
        // 收敛再写新 PCM 同时恢复音量，衔接平滑。
        // 旧实现 i2s_channel_disable+enable 想“清 DMA”，但 disable 让 DAC 输入断，
        // enable 重启又是一次跳变，自己引发“啵”，反效果。
        bool need_unmute_after = false;
        if (codec_in_progress_.load(std::memory_order_relaxed)) {
            xSemaphoreTake(codec_mutex_, portMAX_DELAY);
            ScopedI2cBusLock lock("AudioPlayer::switch_mute");
            if (lock.status() == ESP_OK) {
                esp_codec_dev_set_out_vol(dev_, 0);
            }
            xSemaphoreGive(codec_mutex_);
            need_unmute_after = true;
            // 20 ms 让 DMA 把残留旧 PCM 在 0 vol 下播完（每帧 240 samples / 16 kHz
            // = 15 ms，DMA 6 帧约 90 ms 残留；20 ms 不够清空但够 codec 数字音量
            // 衰减生效,人耳基本听不到)。
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        codec_in_progress_.store(true, std::memory_order_relaxed);

        // 分块写,每块检查 stop_flag_(用户又切歌时立即跳出)。
        size_t off         = 0;
        bool   wrote_first = false;
        while (off < len) {
            bool stop = stop_flag_.load(std::memory_order_acquire);
            if (xiaozhi_active_.load(std::memory_order_relaxed))
                stop = true;
            if (stop)
                break;

            size_t to_write = (len - off) > kChunk ? kChunk : (len - off);
            xSemaphoreTake(codec_mutex_, portMAX_DELAY);
            // esp_audio_codec 的 C API 没有 const-correct；当前 ES8311 write path 不会修改输入 PCM。
            const int ret = esp_codec_dev_write(dev_, const_cast<uint8_t*>(buf + off), static_cast<int>(to_write));
            xSemaphoreGive(codec_mutex_);
            if (ret != ESP_CODEC_DEV_OK) {
                ESP_LOGW(kTag, "write failed ret=0x%x action=stop_current", ret);
                break;
            }
            off += to_write;

            // 第一段 PCM 写下去之后再恢复音量:确保新 PCM 已经到达 DAC 才解 mute,
            // 0 → volume_ 的爬坡跟新 PCM 起始波形混在一起,听感上没有"接通"感。
            if (!wrote_first && need_unmute_after && !xiaozhi_active_.load(std::memory_order_relaxed)) {
                xSemaphoreTake(codec_mutex_, portMAX_DELAY);
                ScopedI2cBusLock lock("AudioPlayer::switch_unmute");
                if (lock.status() == ESP_OK) {
                    esp_codec_dev_set_out_vol(dev_, volume_.load(std::memory_order_relaxed));
                }
                xSemaphoreGive(codec_mutex_);
                wrote_first = true;
            }
        }
        // 兜底:走完整段都没解 mute(比如 PCM < kChunk 又被中断),下次进入
        // 还会再次 set_out_vol(0)→delay→恢复,所以保持 codec_in_progress_=true。
        if (need_unmute_after && !wrote_first && !xiaozhi_active_.load(std::memory_order_relaxed)) {
            xSemaphoreTake(codec_mutex_, portMAX_DELAY);
            ScopedI2cBusLock lock("AudioPlayer::switch_unmute_fallback");
            if (lock.status() == ESP_OK) {
                esp_codec_dev_set_out_vol(dev_, volume_.load(std::memory_order_relaxed));
            }
            xSemaphoreGive(codec_mutex_);
        }

        free(buf);
        ReleaseAudioPmLock();
        // 若 stop_flag_=true 是因为新 Play 设的,notify_ 已被 Give 一次,
        // 下轮 loop 立即取到新 buf。
    }
}
