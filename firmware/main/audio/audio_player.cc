#include "audio_player.h"

#include <esp_codec_dev_defaults.h>
#include <esp_log.h>

#include <cstdlib>
#include <cstring>

#include "config.h"
#include "i2c_bus_lock.h"
#include "volume_store.h"

// Board::Init 已经在 InitPower 阶段把 GPIO42（AVDD_3V3 rail）拉高 + hold_en，
// 所以这里不再直调 BoardI2cForcePowerOn。i2c_device.cc 仍然在异常路径上调
// BoardI2cForcePowerOn 自救，hook 保留在 hal/i2c_power_hook.cc。

namespace {
constexpr char kTag[] = "Audio";
}

AudioPlayer& AudioPlayer::Get() {
    static AudioPlayer p;
    return p;
}

bool AudioPlayer::Init(i2c_master_bus_handle_t i2c_bus) {
    if (initialized_) return true;

    // ── I2S0 master TX-only 16kHz mono 16-bit。本类只播音不录音,
    // 不分配 rx_handle 节省 DMA descriptor。
    i2s_chan_config_t chan_cfg = {};
    chan_cfg.id                = I2S_NUM_0;
    chan_cfg.role              = I2S_ROLE_MASTER;
    chan_cfg.dma_desc_num      = 6;
    chan_cfg.dma_frame_num     = 240;
    // auto_clear_after_cb: 没数据时 DMA 自动填零,避免空闲喇叭啸叫。
    // (老代码用 .auto_clear,IDF 5.4+ 已 deprecated 改为 alias)
    chan_cfg.auto_clear_after_cb = true;
    chan_cfg.intr_priority       = 0;
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx_handle_, nullptr));

    i2s_std_config_t std_cfg = {};
    std_cfg.clk_cfg.sample_rate_hz = AUDIO_OUTPUT_SAMPLE_RATE;
    std_cfg.clk_cfg.clk_src        = I2S_CLK_SRC_DEFAULT;
    std_cfg.clk_cfg.mclk_multiple  = I2S_MCLK_MULTIPLE_256;
    std_cfg.slot_cfg.data_bit_width = I2S_DATA_BIT_WIDTH_16BIT;
    std_cfg.slot_cfg.slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO;
    // 单声道:数据按 left-only 输出。喇叭只一个,STEREO 模式下每采样发两遍
    // 浪费一半 DMA 带宽且 ES8311 寄存器要 stereo→mono 二次配置才正确出声。
    std_cfg.slot_cfg.slot_mode     = I2S_SLOT_MODE_MONO;
    std_cfg.slot_cfg.slot_mask     = I2S_STD_SLOT_LEFT;
    std_cfg.slot_cfg.ws_width      = I2S_DATA_BIT_WIDTH_16BIT;
    std_cfg.slot_cfg.ws_pol        = false;
    std_cfg.slot_cfg.bit_shift     = true;
#ifdef I2S_HW_VERSION_2
    std_cfg.slot_cfg.left_align    = true;
    std_cfg.slot_cfg.big_endian    = false;
    std_cfg.slot_cfg.bit_order_lsb = false;
#endif
    std_cfg.gpio_cfg.mclk          = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_MCLK);
    std_cfg.gpio_cfg.bclk          = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_BCLK);
    std_cfg.gpio_cfg.ws            = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_WS);
    std_cfg.gpio_cfg.dout          = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_DOUT);
    std_cfg.gpio_cfg.din           = static_cast<gpio_num_t>(AUDIO_I2S_GPIO_DIN);
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle_, &std_cfg));
    // 不在这里 i2s_channel_enable —— 跟参考实现 Es8311AudioCodec::CreateDuplexChannels
    // 对齐(esp32-eink/.../es8311_audio_codec.cc:164),让 esp_codec_dev_open 内部
    // 自管 channel state。启动时 codec 库会先 i2s_channel_disable 一个 INIT 状态的
    // channel 打一条 "channel has not been enabled yet" E 级 log,无害,接受。

    // ── ES8311 codec 配置:仅 DAC 输出。ADC/MIC 路径不上电,省功耗 ──
    audio_codec_i2s_cfg_t i2s_data_cfg = {};
    i2s_data_cfg.port      = I2S_NUM_0;
    i2s_data_cfg.tx_handle = tx_handle_;
    i2s_data_cfg.rx_handle = nullptr;
    data_if_ = audio_codec_new_i2s_data(&i2s_data_cfg);
    if (!data_if_) {
        ESP_LOGE(kTag, "audio_codec_new_i2s_data failed");
        return false;
    }

    audio_codec_i2c_cfg_t i2c_cfg = {};
    i2c_cfg.port       = I2C_NUM_0;
    i2c_cfg.addr       = AUDIO_CODEC_ES8311_ADDR;
    i2c_cfg.bus_handle = i2c_bus;
    {
        ScopedI2cBusLock lock("AudioPlayer::Init");
        ESP_ERROR_CHECK(lock.status());
        ctrl_if_ = audio_codec_new_i2c_ctrl(&i2c_cfg);
    }
    if (!ctrl_if_) {
        ESP_LOGE(kTag, "audio_codec_new_i2c_ctrl failed");
        return false;
    }

    gpio_if_ = audio_codec_new_gpio();
    assert(gpio_if_);

    es8311_codec_cfg_t es_cfg     = {};
    es_cfg.ctrl_if                = ctrl_if_;
    es_cfg.gpio_if                = gpio_if_;
    es_cfg.codec_mode             = ESP_CODEC_DEV_WORK_MODE_DAC;  // 只放音,不录
    es_cfg.pa_pin                 = static_cast<gpio_num_t>(AUDIO_CODEC_PA_PIN);
    es_cfg.use_mclk               = true;
    es_cfg.hw_gain.pa_voltage     = 5.0;
    es_cfg.hw_gain.codec_dac_voltage = 3.3;
    es_cfg.pa_reverted            = false;
    codec_if_                     = es8311_codec_new(&es_cfg);
    if (!codec_if_) {
        ESP_LOGE(kTag, "es8311_codec_new failed (I2C 通讯失败?)");
        return false;
    }

    // 创建 codec dev,EnableOutput
    esp_codec_dev_cfg_t dev_cfg = {};
    dev_cfg.dev_type            = ESP_CODEC_DEV_TYPE_OUT;
    dev_cfg.codec_if            = codec_if_;
    dev_cfg.data_if             = data_if_;
    dev_                        = esp_codec_dev_new(&dev_cfg);
    assert(dev_);

    esp_codec_dev_sample_info_t fs = {};
    fs.bits_per_sample             = 16;
    fs.channel                     = 1;
    fs.channel_mask                = 0;
    fs.sample_rate                 = AUDIO_OUTPUT_SAMPLE_RATE;
    fs.mclk_multiple               = 0;
    // 用 NVS 里的音量初始化(用户设置过会保留),首次默认 vol::kDefault*10。
    volume_ = vol::ToCodec(vol::Get());
    {
        ScopedI2cBusLock lock("AudioPlayer::open");
        ESP_ERROR_CHECK(lock.status());
        ESP_ERROR_CHECK(esp_codec_dev_open(dev_, &fs));
        ESP_ERROR_CHECK(esp_codec_dev_set_out_vol(dev_, volume_));
    }

    // PA pin 由 codec lib 自管(es_cfg.pa_pin 已传):dev_open 时上电、close 时下电。
    // 之前手动 gpio_hold_en 把 PA 钉成 1 会让将来 Stop()/省电下电失效,删掉。

    // 后台 task 等通知,有 PCM 时阻塞写
    shared_mutex_ = xSemaphoreCreateMutex();
    notify_       = xSemaphoreCreateBinary();
    xTaskCreatePinnedToCore(&AudioPlayer::TaskEntry, "audio_play", 6 * 1024, this, 5, &task_, 1);

    initialized_ = true;
    ESP_LOGI(kTag, "AudioPlayer ready, sample_rate=%d, vol=%d", AUDIO_OUTPUT_SAMPLE_RATE, volume_);
    return true;
}

void AudioPlayer::Play(const uint8_t* pcm_bytes, size_t len_bytes) {
    if (!initialized_ || pcm_bytes == nullptr || len_bytes == 0) return;
    if (len_bytes & 1) len_bytes &= ~1;  // 取偶,16bit 对齐

    // 深拷贝(LittleFS 缓冲生命周期短),共享 mutex 保护
    uint8_t* copy = static_cast<uint8_t*>(malloc(len_bytes));
    if (!copy) {
        ESP_LOGW(kTag, "Play: malloc %u failed", (unsigned)len_bytes);
        return;
    }
    std::memcpy(copy, pcm_bytes, len_bytes);

    xSemaphoreTake(shared_mutex_, portMAX_DELAY);
    if (pending_pcm_) free(pending_pcm_);
    pending_pcm_ = copy;
    pending_len_ = len_bytes;
    stop_flag_   = true;  // 中断当前播放
    xSemaphoreGive(shared_mutex_);
    xSemaphoreGive(notify_);
}

void AudioPlayer::Stop() {
    if (!initialized_) return;
    xSemaphoreTake(shared_mutex_, portMAX_DELAY);
    if (pending_pcm_) {
        free(pending_pcm_);
        pending_pcm_ = nullptr;
        pending_len_ = 0;
    }
    stop_flag_ = true;
    xSemaphoreGive(shared_mutex_);
}

void AudioPlayer::SetVolume(int v) {
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    volume_ = v;
    if (dev_) {
        ScopedI2cBusLock lock("AudioPlayer::SetVolume");
        if (lock.status() == ESP_OK) {
            esp_codec_dev_set_out_vol(dev_, volume_);
        }
    }
}

void AudioPlayer::TaskEntry(void* arg) {
    static_cast<AudioPlayer*>(arg)->TaskLoop();
    vTaskDelete(nullptr);
}

void AudioPlayer::TaskLoop() {
    // 256B/chunk = 8ms@16kHz mono16:stop_flag 检查粒度更细,切歌响应更及时,
    // 残留 DMA 数据更短(配合 i2s_disable+enable 几乎听不到啵声)。
    constexpr size_t kChunk = 256;
    while (true) {
        // 等通知
        xSemaphoreTake(notify_, portMAX_DELAY);

        // 拿当前 pending
        xSemaphoreTake(shared_mutex_, portMAX_DELAY);
        uint8_t* buf  = pending_pcm_;
        size_t   len  = pending_len_;
        pending_pcm_  = nullptr;
        pending_len_  = 0;
        stop_flag_    = false;
        xSemaphoreGive(shared_mutex_);

        if (!buf || len == 0) continue;

        // 分块写,每块检查 stop_flag_。中断时丢掉 DMA 残留(disable+enable)
        // 防止下一段 PCM 接续旧片段产生「啵」声。
        size_t off       = 0;
        bool   was_stopped = false;
        while (off < len) {
            xSemaphoreTake(shared_mutex_, portMAX_DELAY);
            bool stop = stop_flag_;
            xSemaphoreGive(shared_mutex_);
            if (stop) {
                was_stopped = true;
                break;
            }

            size_t to_write = (len - off) > kChunk ? kChunk : (len - off);
            esp_codec_dev_write(dev_, const_cast<uint8_t*>(buf + off), to_write);
            off += to_write;
        }
        if (was_stopped && tx_handle_) {
            // 丢弃 DMA 里已排队但未发出的 PCM。auto_clear_after_cb 会自动写零,
            // 后续写新 PCM 时立即生效,不会接续旧片段。
            i2s_channel_disable(tx_handle_);
            i2s_channel_enable(tx_handle_);
        }

        free(buf);
        // 若 stop_flag_=true 是因为新 Play 设的,notify_ 已被 Give 一次,
        // 下轮 loop 立即取到新 buf。
    }
}
