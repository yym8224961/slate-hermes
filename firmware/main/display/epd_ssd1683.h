#pragma once

#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lvgl.h>

#include <atomic>
#include <functional>

// SSD1683 类驱动 4.2" 黑白 EPD（400×300，1bpp）+ LVGL 集成。
// SPI 写帧 + 异步 refresh_task（300ms 节流，防过频刷新损伤 EPD）+ LVGL flush_cb
// 阈值化 RGB565→1bpp。RequestUrgentFullRefresh() 立即触发全帧刷新。
class EpdSsd1683 {
   public:
    static constexpr int kWidth     = 400;
    static constexpr int kHeight    = 300;
    static constexpr int kBufferLen = ((kWidth + 7) / 8) * kHeight;

    EpdSsd1683();
    ~EpdSsd1683();

    void Init();

    bool IsRefreshPending();
    void RequestUrgentPartialRefresh();  // partial(~1s 残影)
    void RequestUrgentFullRefresh();     // full(~5s 干净)

    bool Lock(int timeout_ms = 0);
    void Unlock();

    lv_display_t* lvgl_display() {
        return lvgl_display_;
    }

   private:
    spi_device_handle_t spi_        = nullptr;
    bool                spi_inited_ = false;

    uint8_t* buffer_      = nullptr;  // 实时 framebuffer（LVGL flush 写入）
    uint8_t* prev_buffer_ = nullptr;  // 上次刷到 EPD 的快照
    uint8_t* tx_buf_      = nullptr;  // refresh_task 用的临时快照

    // 200 而非 128:LVGL anti-alias 字体边缘的灰度像素被划入"黑",
    // 字体看起来粗实清晰。128 中性二值化会让灰边判白丢失,字体发虚。
    uint8_t bw_threshold_ = 200;

    lv_display_t* lvgl_display_ = nullptr;
    static void   LvglFlushCb(lv_display_t* disp, const lv_area_t* area, uint8_t* color_p);

    SemaphoreHandle_t dirty_mutex_  = nullptr;
    TaskHandle_t      refresh_task_ = nullptr;
    struct Rect {
        int x = 0, y = 0, w = 0, h = 0;
    };
    Rect       dirty_;
    bool       pending_             = false;
    bool       urgent_refresh_      = false;
    bool       force_full_refresh_  = false;
    bool       prev_buffer_synced_  = false;
    bool       refresh_in_progress_ = false;
    TickType_t last_sample_tick_    = 0;
    TickType_t last_flush_tick_     = 0;  // LVGL 最后一次 flush_cb 的时刻,用于等待静默
    int        sample_interval_ms_  = 300;
    int        partial_since_full_  = 0;  // 累积多少次 partial 后强制 full 清残影
    static constexpr int kPartialBeforeFullCleanup = 8;

    void        StartRefreshTask();
    static void RefreshTaskEntry(void* arg);
    void        RefreshTaskLoop();

    void    SpiPortInit();    // 发送模式（DI 当 MOSI，40MHz）
    void    SpiPortRxInit();  // 接收模式（DI 反向当 MISO，8MHz）—— 读温度寄存器
    void    SpiGpioInit();
    void    EpdInit();
    void    EpdDisplayFull();
    void    EpdDisplayPartial();
    void    EpdTurnOnDisplay();
    // 读屏内温度寄存器(0x40)→映射 5 档 booster 写 0xE0/0xE6,Full/Partial 共用。
    // 60s 内重复刷新会复用上次温度避免每次 5-10ms 切换 SPI 模式开销。
    void    ApplyTemperatureBoost();
    int64_t last_temp_read_ms_ = 0;
    uint8_t cached_booster_    = 0;
    void    EpdSendCommand(uint8_t c);
    void    EpdSendData(uint8_t d);
    uint8_t EpdRecvData();  // 切到 RX 模式读 1 字节,读完切回 TX
    void    WriteBytes(const uint8_t* buf, int len);
    void    ReadBusy();
    void    EpdPowerOn();   // 主动管 EPD_PWR_PIN(含 hold_dis/set/hold_en)
    void    EpdPowerOff();

    // pin 缓存（来自 hal/config.h）
    gpio_num_t        cs_, dc_, rst_, busy_, mosi_, sclk_;
    spi_host_device_t spi_host_;
};
