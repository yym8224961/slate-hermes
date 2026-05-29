#include "epd_ssd1683.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_lvgl_port.h>
#include <esp_system.h>
#include <esp_timer.h>

#include <algorithm>
#include <cstring>

#include "config.h"
#include "epd_utils.h"
#include "gpio_util.h"

namespace {
constexpr char kTag[] = "Epd";
}

namespace {
class LvglPortLockGuard {
   public:
    LvglPortLockGuard() : locked_(lvgl_port_lock(0)) {
    }
    ~LvglPortLockGuard() {
        if (locked_)
            lvgl_port_unlock();
    }
    LvglPortLockGuard(const LvglPortLockGuard&)            = delete;
    LvglPortLockGuard& operator=(const LvglPortLockGuard&) = delete;
    bool               locked() const {
        return locked_;
    }

   private:
    bool locked_ = false;
};

}  // namespace

EpdSsd1683::EpdSsd1683() {
    cs_       = static_cast<gpio_num_t>(EPD_CS_PIN);
    dc_       = static_cast<gpio_num_t>(EPD_DC_PIN);
    rst_      = static_cast<gpio_num_t>(EPD_RST_PIN);
    busy_     = static_cast<gpio_num_t>(EPD_BUSY_PIN);
    mosi_     = static_cast<gpio_num_t>(EPD_MOSI_PIN);
    sclk_     = static_cast<gpio_num_t>(EPD_SCK_PIN);
    spi_host_ = static_cast<spi_host_device_t>(EPD_SPI_NUM);
}

EpdSsd1683::~EpdSsd1683() {
    if (refresh_task_) {
        xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
        refresh_task_stop_ = true;
        xSemaphoreGive(dirty_mutex_);
        xTaskNotifyGive(refresh_task_);
        if (refresh_exit_)
            xSemaphoreTake(refresh_exit_, portMAX_DELAY);
        refresh_task_ = nullptr;
    }
    LvglPortLockGuard lvgl_lock;
    if (lvgl_display_ && lvgl_lock.locked()) {
        lv_display_delete(lvgl_display_);
        lvgl_display_ = nullptr;
    }
    if (spi_ && spi_inited_) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(spi_bus_remove_device(spi_));
        spi_ = nullptr;
    }
    if (spi_inited_) {
        esp_err_t free_ret = spi_bus_free(spi_host_);
        if (free_ret != ESP_OK && free_ret != ESP_ERR_INVALID_STATE) {
            ESP_ERROR_CHECK_WITHOUT_ABORT(free_ret);
        }
        spi_inited_ = false;
    }
    if (dirty_mutex_) {
        vSemaphoreDelete(dirty_mutex_);
        dirty_mutex_ = nullptr;
    }
    if (refresh_exit_) {
        vSemaphoreDelete(refresh_exit_);
        refresh_exit_ = nullptr;
    }
    heap_caps_free(buffer_);
    heap_caps_free(prev_buffer_);
    heap_caps_free(tx_buf_);
    heap_caps_free(prev_tx_buf_);
    heap_caps_free(lvgl_render_buf_);
    buffer_ = prev_buffer_ = tx_buf_ = prev_tx_buf_ = lvgl_render_buf_ = nullptr;
}

void EpdSsd1683::Init() {
    SpiPortInit();
    SpiGpioInit();
    // 不在驱动初始化阶段主动刷新屏幕。EPD 物理画面可在断电后保留；
    // 首屏/内容变化由上层 RequestUrgent*Refresh 触发时再 EpdInit + 刷新。
    EpdPowerOff();

    lvgl_port_cfg_t pc = ESP_LVGL_PORT_INIT_CONFIG();
    pc.task_priority   = 2;
    pc.timer_period_ms = 50;
    lvgl_port_init(&pc);
    LvglPortLockGuard lvgl_lock;
    if (!lvgl_lock.locked()) {
        // Init 失败后续 Refresh 会读到半初始化的 lvgl_display_/buffer_ 段错误。
        // 直接重启，OOM/资源问题往往在重启后能恢复，比留下"看似活着的死设备"安全。
        ESP_LOGE(kTag, "Failed to lock LVGL during init; restarting");
        esp_restart();
    }

    buffer_      = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    prev_buffer_ = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    tx_buf_      = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    prev_tx_buf_ = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    if (!buffer_ || !prev_buffer_ || !tx_buf_ || !prev_tx_buf_) {
        ESP_LOGE(kTag, "Failed to allocate framebuffers; restarting");
        esp_restart();
    }
    memset(buffer_, 0xFF, kBufferLen);
    memset(prev_buffer_, 0xFF, kBufferLen);
    memset(tx_buf_, 0xFF, kBufferLen);
    memset(prev_tx_buf_, 0xFF, kBufferLen);
    epd_line_.resize(((kWidth + 7) >> 3) * 2);

    dirty_mutex_ = xSemaphoreCreateMutex();
    if (!dirty_mutex_) {
        ESP_LOGE(kTag, "Failed to create dirty_mutex; restarting");
        esp_restart();
    }
    refresh_exit_ = xSemaphoreCreateBinary();
    if (!refresh_exit_) {
        ESP_LOGE(kTag, "Failed to create refresh_exit; restarting");
        esp_restart();
    }

    lvgl_display_ = lv_display_create(kWidth, kHeight);
    if (!lvgl_display_) {
        ESP_LOGE(kTag, "Failed to create LVGL display; restarting");
        esp_restart();
    }
    lv_display_set_flush_cb(lvgl_display_, LvglFlushCb);
    lv_display_set_user_data(lvgl_display_, this);

    constexpr int kRenderRows = 40;
    constexpr int kRender     = kWidth * kRenderRows * 2;
    lvgl_render_buf_          = (uint8_t*)heap_caps_malloc(kRender, MALLOC_CAP_SPIRAM);
    if (!lvgl_render_buf_) {
        ESP_LOGE(kTag, "Failed to allocate render buffer; restarting");
        esp_restart();
    }
    // Partial mode intentionally uses a single LVGL render buffer. The async EPD
    // refresh task owns separate 1bpp frame buffers, so a second LVGL draw buffer
    // would only increase PSRAM use without changing panel refresh semantics.
    lv_display_set_buffers(lvgl_display_, lvgl_render_buf_, NULL, kRender, LV_DISPLAY_RENDER_MODE_PARTIAL);

    StartRefreshTask();
}

bool EpdSsd1683::Lock(int t) {
    return lvgl_port_lock(t);
}
void EpdSsd1683::Unlock() {
    lvgl_port_unlock();
}

void EpdSsd1683::LvglFlushCb(lv_display_t* disp, const lv_area_t* area, uint8_t* color_p) {
    auto* self = static_cast<EpdSsd1683*>(lv_display_get_user_data(disp));
    xSemaphoreTake(self->dirty_mutex_, portMAX_DELAY);

    const uint16_t* src = (const uint16_t*)color_p;
    int             x1  = std::max(0, (int)area->x1);
    int             y1  = std::max(0, (int)area->y1);
    int             x2  = std::min(kWidth - 1, (int)area->x2);
    int             y2  = std::min(kHeight - 1, (int)area->y2);
    int             w = x2 - x1 + 1, h = y2 - y1 + 1;
    int             sw = (area->x2 - area->x1 + 1);
    for (int yy = 0; yy < h; ++yy) {
        const uint16_t* row = src + (yy + (y1 - area->y1)) * sw + (x1 - area->x1);
        for (int xx = 0; xx < w; ++xx) {
            bool white = epd::Rgb565IsWhite(row[xx], self->bw_threshold_);
            epd::SetPx1(self->buffer_, kWidth, x1 + xx, y1 + yy, white);
        }
    }

    epd::Rect r            = {x1, y1, w, h};
    r                      = epd::Clamp(epd::AlignX8(r), kWidth, kHeight);
    bool         do_notify = false;
    TaskHandle_t task      = nullptr;
    if (epd::Area(r) > 0) {
        epd::Rect u            = epd::Union(self->dirty_, r);
        self->dirty_           = u;
        self->pending_         = true;
        self->last_flush_tick_ = xTaskGetTickCount();
        // flush_cb notify refresh_task。LVGL 整屏 invalidate 可能分多个 chunk
        // 多次调用 flush_cb,refresh_task 头部的 sliding debounce 把这些 notify
        // 合并成一轮刷新——所以这里大胆 notify，不会出现「半成品 buffer 抢跑全刷」。
        task      = self->refresh_task_;
        do_notify = (task != nullptr);
        // LVGL flush 高频,默认 ESP_LOGD 隐藏。需要诊断"残影 / partial 区不正确"
        // 时,串口跑一次 esp_log_level_set("Epd", ESP_LOG_DEBUG) 打开。
        ESP_LOGD(kTag, "Flush chunk=(%d,%d,%dx%d) accum_dirty=(%d,%d,%dx%d)", r.x, r.y, r.w, r.h, u.x, u.y, u.w, u.h);
    }

    xSemaphoreGive(self->dirty_mutex_);
    if (do_notify)
        xTaskNotifyGive(task);
    lv_disp_flush_ready(disp);
}

bool EpdSsd1683::IsRefreshPending() {
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    // force_full_refresh_ 直到全刷完成才清，覆盖整个「main 调 RequestUrgentFullRefresh
    // → LVGL 渲染 → flush_cb notify → refresh_task 全刷」的等待窗口。
    bool b = pending_ || urgent_refresh_ || force_full_refresh_ || refresh_in_progress_;
    xSemaphoreGive(dirty_mutex_);
    return b;
}

void EpdSsd1683::RequestUrgentPartialRefresh() {
    // 设标志位 + notify,立即返回。不在这里等 LVGL,因为 flush_cb 也会 notify;
    // RefreshTaskLoop 头部的 sliding debounce（50 ms 内有新 notify 就续 50 ms，
    // 最长 500 ms）会自然吸收「ShowCar 后 LVGL 50 ms 才 flush」这一段时间。
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    urgent_refresh_      = true;
    refresh_in_progress_ = true;
    xSemaphoreGive(dirty_mutex_);
    if (refresh_task_)
        xTaskNotifyGive(refresh_task_);
}

void EpdSsd1683::RequestUrgentFullRefresh() {
    // 同上:设 force_full + notify,立即返回。debounce 吸收 LVGL flush。
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    force_full_refresh_  = true;
    refresh_in_progress_ = true;
    xSemaphoreGive(dirty_mutex_);
    if (refresh_task_)
        xTaskNotifyGive(refresh_task_);
}

void EpdSsd1683::WriteRaw1bpp(int x, int y, int w, int h, const uint8_t* data, size_t len) {
    if (!data || w <= 0 || h <= 0)
        return;
    const int src_bpr = (w + 7) >> 3;
    if (len < static_cast<size_t>(src_bpr * h))
        return;
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    epd::Copy1bppInto(buffer_, kWidth, kHeight, x, y, w, h, data);
    epd::Rect r = epd::Clamp(epd::AlignX8({x, y, w, h}), kWidth, kHeight);
    if (epd::Area(r) > 0) {
        epd::Rect u      = epd::Union(dirty_, r);
        dirty_           = u;
        pending_         = true;
        last_flush_tick_ = xTaskGetTickCount();
        if (refresh_task_)
            xTaskNotifyGive(refresh_task_);
    }
    xSemaphoreGive(dirty_mutex_);
}

void EpdSsd1683::SeedPreviousRaw1bpp(int x, int y, int w, int h, const uint8_t* data, size_t len) {
    if (!data || w <= 0 || h <= 0)
        return;
    const int src_bpr = (w + 7) >> 3;
    if (len < static_cast<size_t>(src_bpr * h))
        return;

    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    epd::Copy1bppInto(buffer_, kWidth, kHeight, x, y, w, h, data);
    epd::Copy1bppInto(prev_buffer_, kWidth, kHeight, x, y, w, h, data);
    prev_buffer_synced_ = true;
    xSemaphoreGive(dirty_mutex_);
}

bool EpdSsd1683::ReadPreviousRaw1bpp(int x, int y, int w, int h, uint8_t* out, size_t len) {
    if (!out || w <= 0 || h <= 0)
        return false;
    const int dst_bpr = (w + 7) >> 3;
    if (len < static_cast<size_t>(dst_bpr * h))
        return false;

    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    const bool synced = prev_buffer_synced_;
    if (synced) {
        epd::Copy1bppFrom(prev_buffer_, kWidth, kHeight, x, y, w, h, out);
    }
    xSemaphoreGive(dirty_mutex_);
    return synced;
}

void EpdSsd1683::StartRefreshTask() {
    BaseType_t ok = xTaskCreatePinnedToCore(RefreshTaskEntry, "epd_refresh", 8192, this, 3, &refresh_task_, 1);
    if (ok != pdPASS) {
        refresh_task_ = nullptr;
        ESP_LOGE(kTag, "epd_refresh task create failed");
    }
}
void EpdSsd1683::RefreshTaskEntry(void* arg) {
    static_cast<EpdSsd1683*>(arg)->RefreshTaskLoop();
}

void EpdSsd1683::RefreshTaskLoop() {
    constexpr TickType_t kDebounceMs    = 50;   // 每来一次新 notify，续 50 ms
    constexpr TickType_t kDebounceMaxMs = 500;  // 兜底：总等待最多 500 ms，防止 LVGL 永不静默
    while (true) {
        // 第一次阻塞等 notify。来源:flush_cb / RequestUrgentXxxRefresh / 周期采样(已废)。
        if (ulTaskNotifyTake(pdTRUE, portMAX_DELAY) == 0)
            continue;

        xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
        bool should_stop = refresh_task_stop_;
        xSemaphoreGive(dirty_mutex_);
        if (should_stop)
            break;

        // Sliding debounce：在 50 ms 窗口内吸收所有新 notify，每来一次重置窗口，
        // 直到 50 ms 没有新 notify 才进入真正的刷新。这一步把 LVGL 把整屏
        // invalidate 分成多个 chunk 多次调用 flush_cb 的"碎片"合并成一轮刷新。
        TickType_t first_tick = xTaskGetTickCount();
        TickType_t hard_max   = first_tick + pdMS_TO_TICKS(kDebounceMaxMs);
        TickType_t deadline   = first_tick + pdMS_TO_TICKS(kDebounceMs);
        while (true) {
            TickType_t now = xTaskGetTickCount();
            if (now >= deadline || now >= hard_max)
                break;
            TickType_t wait = (deadline < hard_max ? deadline : hard_max) - now;
            if (ulTaskNotifyTake(pdTRUE, wait) > 0) {
                // 又一次 notify（更多 flush_cb 或新的 Request）→ 续 50 ms。
                deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kDebounceMs);
            }
        }

        // read-and-clear at start:防止 refresh_task 跑刷新期间又有
        // RequestUrgentXxxRefresh 设 flag 时,本轮完成时把它误清。
        xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
        should_stop = refresh_task_stop_;
        if (should_stop) {
            refresh_in_progress_ = false;
            xSemaphoreGive(dirty_mutex_);
            break;
        }
        bool urgent         = urgent_refresh_;
        urgent_refresh_     = false;
        bool force_full     = force_full_refresh_;
        force_full_refresh_ = false;
        if (pending_) {
            pending_ = false;
            dirty_   = {0, 0, 0, 0};
        }
        xSemaphoreGive(dirty_mutex_);

        if (!urgent && !force_full) {
            // 周期性采样:LVGL 自驱(动画/滚动)flush 触发 notify,但没设 urgent flag。
            // sample_interval_ms_ 节流防止过频刷新损伤 EPD。
            TickType_t now_t = xTaskGetTickCount();
            TickType_t mn    = pdMS_TO_TICKS(sample_interval_ms_);
            TickType_t el    = (last_sample_tick_ == 0) ? mn : (now_t - last_sample_tick_);
            if (el < mn) {
                vTaskDelay(mn - el);
                continue;
            }
        }

        xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
        memcpy(tx_buf_, buffer_, kBufferLen);
        memcpy(prev_tx_buf_, prev_buffer_, kBufferLen);
        bool prev_synced = prev_buffer_synced_;
        xSemaphoreGive(dirty_mutex_);
        last_sample_tick_ = xTaskGetTickCount();

        epd::DiffResult d = epd::Diff(prev_tx_buf_, tx_buf_, kBufferLen);
        if (d.bits == 0 && !force_full) {
            xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
            refresh_in_progress_ = false;
            xSemaphoreGive(dirty_mutex_);
            continue;
        }

        // 决策 full vs partial:force_full / 累积 partial >= 阈值 / 差异 ≥ 30%(大改动
        // partial 出来会一片错乱) → 必须 full;首次未 sync 也要 full。timer wake
        // 会先用 SeedPreviousRaw1bpp 把 prev_buffer 跟物理屏幕对齐,不需要额外越过。
        // 两条路径都先调 EpdInit() 做硬 reset + 寄存器初始化:
        // 1) full 路径里 EpdDisplayFull 自己会发 0xA5 切到 full 模式;
        // 2) partial 路径靠 EpdInit 把 EPD 拉回默认/partial 模式,否则上一轮
        //    full 留下的 0xA5 LUT 会让本轮 partial 视觉上变成全刷闪一下。
        constexpr float kForceFullDiffRatio = 0.30f;
        bool            do_full             = force_full || partial_since_full_ >= kPartialBeforeFullCleanup ||
                       d.ratio >= kForceFullDiffRatio || !prev_synced;

        if (do_full) {
            EpdInit();
            EpdDisplayFull();
            partial_since_full_ = 0;
        } else {
            partial_since_full_++;
            // 跟参考实现对齐:每次 PARTIAL 也先做完整 EpdInit(含 PowerOn + RESET +
            // 重发初始化命令),跟末尾 EpdTurnOnDisplay 内的 EpdPowerOff 配对。
            // 之前为了省 ~40 ms 让 partial → partial 不重 init，但 EpdTurnOnDisplay
            // 末尾仍 PowerOff,导致下一轮 partial 命令送到已断电的 controller,
            // 表现为"屏幕变更黑一点但图没切"。
            EpdInit();
            EpdDisplayPartial();
        }

        // force_full_refresh_ 已在 start 处清(read-and-clear)。这里不要重设,
        // 否则会覆盖全刷期间又有新 RequestUrgentFullRefresh 设的 true。
        xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
        memcpy(prev_buffer_, tx_buf_, kBufferLen);
        prev_buffer_synced_  = true;
        refresh_in_progress_ = false;
        xSemaphoreGive(dirty_mutex_);
    }
    if (refresh_exit_)
        xSemaphoreGive(refresh_exit_);
    vTaskDelete(nullptr);
}

// SPI 反复 free + reinit 是为了切换 DI 数据线方向(EPD 单数据线复用 MOSI/MISO):
// 写命令/数据走 mosi_io_num=mosi_(发送),读温度时 miso_io_num=mosi_(同一物理引脚反向接收)。
void EpdSsd1683::SpiPortInit() {
    if (spi_ && spi_inited_) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(spi_bus_remove_device(spi_));
        spi_ = nullptr;
    }
    if (spi_inited_) {
        esp_err_t free_ret = spi_bus_free(spi_host_);
        if (free_ret != ESP_OK && free_ret != ESP_ERR_INVALID_STATE) {
            ESP_ERROR_CHECK(free_ret);
        }
        spi_inited_ = false;
    }
    spi_bus_config_t b              = {};
    b.miso_io_num                   = -1;
    b.mosi_io_num                   = mosi_;
    b.sclk_io_num                   = sclk_;
    b.quadwp_io_num                 = -1;
    b.quadhd_io_num                 = -1;
    b.max_transfer_sz               = kBufferLen * 2;
    spi_device_interface_config_t d = {};
    d.spics_io_num                  = -1;
    d.clock_speed_hz                = 40 * 1000 * 1000;
    d.mode                          = 0;
    d.queue_size                    = 7;
    ESP_ERROR_CHECK(spi_bus_initialize(spi_host_, &b, SPI_DMA_CH_AUTO));
    ESP_ERROR_CHECK(spi_bus_add_device(spi_host_, &d, &spi_));
    spi_inited_ = true;
}

void EpdSsd1683::SpiPortRxInit() {
    if (spi_ && spi_inited_) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(spi_bus_remove_device(spi_));
        spi_ = nullptr;
    }
    if (spi_inited_) {
        esp_err_t free_ret = spi_bus_free(spi_host_);
        if (free_ret != ESP_OK && free_ret != ESP_ERR_INVALID_STATE) {
            ESP_ERROR_CHECK(free_ret);
        }
        spi_inited_ = false;
    }
    spi_bus_config_t b              = {};
    b.miso_io_num                   = mosi_;  // DI 反向当 MISO 收数据
    b.mosi_io_num                   = -1;
    b.sclk_io_num                   = sclk_;
    b.quadwp_io_num                 = -1;
    b.quadhd_io_num                 = -1;
    b.max_transfer_sz               = kBufferLen * 2;
    spi_device_interface_config_t d = {};
    d.spics_io_num                  = -1;
    d.clock_speed_hz                = 8 * 1000 * 1000;  // 读时降速到 8 MHz
    d.mode                          = 0;
    d.queue_size                    = 7;
    ESP_ERROR_CHECK(spi_bus_initialize(spi_host_, &b, SPI_DMA_CH_AUTO));
    ESP_ERROR_CHECK(spi_bus_add_device(spi_host_, &d, &spi_));
    spi_inited_ = true;
}

uint8_t EpdSsd1683::EpdRecvData() {
    // SPI RX/TX 模式切换会 remove/free/reinit bus。当前只允许 refresh_task
    // 在刷新序列里调用,避免其它任务同时操作同一组 EPD 引脚。
    configASSERT(refresh_task_ == nullptr || xTaskGetCurrentTaskHandle() == refresh_task_);
    SpiPortRxInit();
    uint8_t           rx = 0;
    spi_transaction_t t  = {};
    t.length             = 8;
    t.rx_buffer          = &rx;
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
    SpiPortInit();
    return rx;
}

void EpdSsd1683::SpiGpioInit() {
    // EPD_PWR_PIN(GPIO6) 由本类自管(BoardPowerBsp 不再接管),先配成 OUTPUT。
    gpio_config_t gpwr = {};
    gpwr.intr_type     = GPIO_INTR_DISABLE;
    gpwr.mode          = GPIO_MODE_OUTPUT;
    gpwr.pin_bit_mask  = 1ULL << EPD_PWR_PIN;
    gpwr.pull_up_en    = GPIO_PULLUP_DISABLE;
    gpwr.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    gpio_config(&gpwr);

    gpio_config_t g = {};
    g.intr_type     = GPIO_INTR_DISABLE;
    g.mode          = GPIO_MODE_OUTPUT;
    g.pin_bit_mask  = (1ULL << cs_) | (1ULL << dc_) | (1ULL << rst_);
    g.pull_up_en    = GPIO_PULLUP_DISABLE;
    g.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    gpio_config(&g);
    g.mode         = GPIO_MODE_INPUT;
    g.pin_bit_mask = (1ULL << busy_);
    gpio_config(&g);
    gpio_set_level(rst_, 1);
    gpio_set_level(cs_, 1);  // CS 默认拉高(SPI device 不被选中)
}

void EpdSsd1683::ReadBusy() {
    // 5s 超时兜底:屏挂死/带线松了不会让 refresh task 永久阻塞。
    // 正常 full 刷 ~3s,partial ~1s,5s 留足余量。超时直接 panic 重启,
    // 比挂死 + WDT 复位更可控,日志也更明确。
    constexpr int64_t kBusyTimeoutMs = 5000;
    const int64_t     start_ms       = esp_timer_get_time() / 1000;
    while (gpio_get_level(busy_) == 0) {
        vTaskDelay(pdMS_TO_TICKS(5));
        if ((esp_timer_get_time() / 1000) - start_ms > kBusyTimeoutMs) {
            ESP_LOGE(kTag, "EPD BUSY stuck low > %lldms -> restarting", kBusyTimeoutMs);
            esp_restart();
        }
    }
}

void EpdSsd1683::EpdSendCommand(uint8_t c) {
    gpio_set_level(dc_, 0);
    gpio_set_level(cs_, 0);
    spi_transaction_t t = {};
    t.length            = 8;
    t.tx_buffer         = &c;
    spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
}

void EpdSsd1683::EpdSendData(uint8_t d) {
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    spi_transaction_t t = {};
    t.length            = 8;
    t.tx_buffer         = &d;
    spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
}

void EpdSsd1683::WriteBytes(const uint8_t* buf, int len) {
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    spi_transaction_t t = {};
    t.length            = 8 * len;
    t.tx_buffer         = buf;
    spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
}

void EpdSsd1683::EpdPowerOn() {
    GpioWriteHold(EPD_PWR_PIN, 1);
}
void EpdSsd1683::EpdPowerOff() {
    GpioWriteHold(EPD_PWR_PIN, 0);
}

void EpdSsd1683::EpdInit() {
    EpdPowerOn();
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(rst_, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(rst_, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(rst_, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    ReadBusy();
    EpdSendCommand(0x00);
    EpdSendData(0x2F);
    EpdSendData(0x2E);
    EpdSendCommand(0xE9);
    EpdSendData(0x01);
    ReadBusy();
}

void EpdSsd1683::ApplyTemperatureBoost() {
    // 0x40 = Get Temp,ReadBusy 后 EPD 把片内温度寄存器值放到 DI 上,SPI 反向读 1B。
    // 这次切换 SPI 模式约 5~10 ms，所以 60 s 内复用上次结果（屏温变化很慢）。
    constexpr int64_t kCacheValidMs = 60 * 1000;
    const int64_t     now_ms        = esp_timer_get_time() / 1000;

    uint8_t booster;
    if (cached_booster_ != 0 && (now_ms - last_temp_read_ms_) < kCacheValidMs) {
        booster = cached_booster_;
    } else {
        EpdSendCommand(0x40);
        ReadBusy();
        const uint8_t temp = EpdRecvData();
        // 5 档:≤5°C 用 -24°C 偏置(0xE8),≤10 用 -21,≤20 用 -18,≤30 用 -15,
        // ≤127 用 -12;>127(寄存器异常)按最冷处理。
        if (temp <= 5)
            booster = 232;
        else if (temp <= 10)
            booster = 235;
        else if (temp <= 20)
            booster = 238;
        else if (temp <= 30)
            booster = 241;
        else if (temp <= 127)
            booster = 244;
        else
            booster = 232;
        cached_booster_    = booster;
        last_temp_read_ms_ = now_ms;
    }

    EpdSendCommand(0xE0);
    EpdSendData(0x02);
    EpdSendCommand(0xE6);
    EpdSendData(booster);
}

void EpdSsd1683::EpdDisplayFull() {
    int      bpr     = (kWidth + 7) >> 3;
    int      bpr_out = bpr * 2;
    uint8_t* line    = epd_line_.data();

    ApplyTemperatureBoost();
    EpdSendCommand(0xA5);  // Master Activation:加载 LUT(full 模式必需)
    ReadBusy();
    vTaskDelay(pdMS_TO_TICKS(10));

    EpdSendCommand(0x10);
    for (int y = 0; y < kHeight; ++y) {
        const uint8_t* src = tx_buf_ + y * bpr;
        uint8_t*       dst = line;
        for (int xb = 0; xb < bpr; ++xb) {
            uint8_t a, b;
            epd::Pack1bppTo2683(src[xb], a, b);
            *dst++ = a;
            *dst++ = b;
        }
        WriteBytes(line, bpr_out);
    }
    EpdTurnOnDisplay();
}

void EpdSsd1683::EpdDisplayPartial() {
    int      bpr     = (kWidth + 7) >> 3;
    int      bpr_out = bpr * 2;
    uint8_t* line    = epd_line_.data();

    // 不要重写 booster!
    // 之前这里调了 ApplyTemperatureBoost 想"低温补偿",但实测每次 partial 前
    // 发 0xE0 0xE6 会把 SSD1683 切回 boost-charge 状态,partial LUT 失效,
    // 屏幕看起来"日志在刷但完全没变化"。booster 在上一轮 FULL 路径的
    // ApplyTemperatureBoost + EpdInit 时已经设好,partial 复用即可。
    // 参考 esp32-eink/.../custom_lcd_display.cc:1135 EPD_DisplayPart 同样不写 booster。

    EpdSendCommand(0x10);
    ReadBusy();  // 跟参考实现对齐:0x10 之后等 BUSY 回 HIGH
    for (int y = 0; y < kHeight; ++y) {
        const uint8_t* prev = prev_tx_buf_ + y * bpr;
        const uint8_t* now  = tx_buf_ + y * bpr;
        for (int xb = 0; xb < bpr; ++xb) {
            uint8_t  b1 = prev[xb], b2 = now[xb];
            uint16_t r = 0;
            for (int k = 0; k < 8; ++k) {
                int sb = 7 - k;
                r |= ((uint16_t)((b1 >> sb) & 1)) << (2 * sb + 1);
                r |= ((uint16_t)((b2 >> sb) & 1)) << (2 * sb);
            }
            line[2 * xb + 0] = r >> 8;
            line[2 * xb + 1] = r & 0xFF;
        }
        WriteBytes(line, bpr_out);
    }
    EpdTurnOnDisplay();
}

void EpdSsd1683::EpdTurnOnDisplay() {
    EpdSendCommand(0x04);  // power on
    ReadBusy();
    EpdSendCommand(0x12);  // display refresh
    EpdSendData(0x00);
    ReadBusy();
    EpdSendCommand(0x02);  // power off (controller internal)
    EpdSendData(0x00);
    ReadBusy();
    // 跟参考实现对齐:每次刷完屏都断 GPIO6,跟刷新前的 EpdInit() 内 EpdPowerOn 配对。
    // 见 esp32-eink/main/boards/zectrix-s3-epaper-4.2/custom_lcd_display.cc:826。
    EpdPowerOff();
}
