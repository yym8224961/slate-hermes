#include "drivers/display/epd_ssd1683.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_lvgl_port.h>
#include <esp_system.h>
#include <esp_timer.h>

#include <algorithm>
#include <cstring>

#include "bsp/config.h"
#include "drivers/display/framebuffer_ops.h"
#include "utils/gpio_util.h"

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
    heap_caps_free(snapshot_);
    heap_caps_free(prev_snapshot_);
    heap_caps_free(lvgl_render_buf_);
    buffer_ = snapshot_ = prev_snapshot_ = lvgl_render_buf_ = nullptr;
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

    buffer_        = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    snapshot_      = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    prev_snapshot_ = (uint8_t*)heap_caps_malloc(kBufferLen, MALLOC_CAP_SPIRAM);
    if (!buffer_ || !snapshot_ || !prev_snapshot_) {
        ESP_LOGE(kTag, "Failed to allocate framebuffers; restarting");
        esp_restart();
    }
    memset(buffer_, 0xFF, kBufferLen);
    memset(snapshot_, 0xFF, kBufferLen);
    memset(prev_snapshot_, 0xFF, kBufferLen);
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
            bool white = epd::Rgb565IsWhite(row[xx], kBwThreshold);
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

bool EpdSsd1683::WaitForRefreshIdle(int timeout_ms) {
    int waited = 0;
    while (IsRefreshPending() && waited < timeout_ms) {
        vTaskDelay(pdMS_TO_TICKS(50));
        waited += 50;
    }
    return !IsRefreshPending();
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
    epd::Copy1bppInto(prev_snapshot_, kWidth, kHeight, x, y, w, h, data);
    prev_snapshot_synced_ = true;
    xSemaphoreGive(dirty_mutex_);
}

bool EpdSsd1683::ReadPreviousRaw1bpp(int x, int y, int w, int h, uint8_t* out, size_t len) {
    if (!out || w <= 0 || h <= 0)
        return false;
    const int dst_bpr = (w + 7) >> 3;
    if (len < static_cast<size_t>(dst_bpr * h))
        return false;

    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    const bool synced = prev_snapshot_synced_;
    if (synced) {
        epd::Copy1bppFrom(prev_snapshot_, kWidth, kHeight, x, y, w, h, out);
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

bool EpdSsd1683::RefreshTaskShouldStop() {
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    const bool should_stop = refresh_task_stop_;
    xSemaphoreGive(dirty_mutex_);
    return should_stop;
}

void EpdSsd1683::DebounceRefreshNotify() {
    constexpr TickType_t kDebounceMs    = 50;   // 每来一次新 notify，续 50 ms
    constexpr TickType_t kDebounceMaxMs = 500;  // 兜底：总等待最多 500 ms，防止 LVGL 永不静默

    // Sliding debounce：在 50 ms 窗口内吸收所有新 notify，每来一次重置窗口，
    // 直到 50 ms 没有新 notify 才进入真正的刷新。这一步把 LVGL 把整屏
    // invalidate 分成多个 chunk 多次调用 flush_cb 的"碎片"合并成一轮刷新。
    const TickType_t first_tick = xTaskGetTickCount();
    const TickType_t hard_max   = first_tick + pdMS_TO_TICKS(kDebounceMaxMs);
    TickType_t       deadline   = first_tick + pdMS_TO_TICKS(kDebounceMs);
    while (true) {
        const TickType_t now = xTaskGetTickCount();
        if (now >= deadline || now >= hard_max)
            break;
        const TickType_t wait = (deadline < hard_max ? deadline : hard_max) - now;
        if (ulTaskNotifyTake(pdTRUE, wait) > 0) {
            deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kDebounceMs);
        }
    }
}

bool EpdSsd1683::TakeRefreshRequest(bool& urgent, bool& force_full) {
    // read-and-clear at start:防止 refresh_task 跑刷新期间又有
    // RequestUrgentXxxRefresh 设 flag 时,本轮完成时把它误清。
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    if (refresh_task_stop_) {
        refresh_in_progress_ = false;
        xSemaphoreGive(dirty_mutex_);
        return false;
    }
    urgent              = urgent_refresh_;
    urgent_refresh_     = false;
    force_full          = force_full_refresh_;
    force_full_refresh_ = false;
    if (pending_) {
        pending_ = false;
        dirty_   = {0, 0, 0, 0};
    }
    xSemaphoreGive(dirty_mutex_);
    return true;
}

bool EpdSsd1683::ThrottleRefreshSampling(bool urgent, bool force_full) {
    if (urgent || force_full)
        return true;

    // 周期性采样:LVGL 自驱(动画/滚动)flush 触发 notify,但没设 urgent flag。
    // sample_interval_ms_ 节流防止过频刷新损伤 EPD。
    const TickType_t now_t = xTaskGetTickCount();
    const TickType_t mn    = pdMS_TO_TICKS(sample_interval_ms_);
    const TickType_t el    = (last_sample_tick_ == 0) ? mn : (now_t - last_sample_tick_);
    if (el < mn) {
        vTaskDelay(mn - el);
        return false;
    }
    return true;
}

bool EpdSsd1683::CaptureRefreshSnapshot(bool force_full, epd::DiffResult& diff, bool& prev_synced) {
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    memcpy(snapshot_, buffer_, kBufferLen);
    prev_synced = prev_snapshot_synced_;
    xSemaphoreGive(dirty_mutex_);
    last_sample_tick_ = xTaskGetTickCount();

    diff = epd::Diff(prev_snapshot_, snapshot_, kBufferLen);
    if (diff.bits == 0 && !force_full) {
        MarkRefreshIdle();
        return false;
    }
    return true;
}

bool EpdSsd1683::ShouldUseFullRefresh(const epd::DiffResult& diff, bool force_full, bool prev_synced) const {
    // 决策 full vs partial:force_full / 累积 partial >= 阈值 / 差异 ≥ 30%(大改动
    // partial 出来会一片错乱) → 必须 full;首次未 sync 也要 full。timer wake
    // 会先用 SeedPreviousRaw1bpp 把 prev_snapshot 跟物理屏幕对齐,不需要额外越过。
    constexpr float kForceFullDiffRatio = 0.30f;
    return force_full || partial_since_full_ >= kPartialBeforeFullCleanup || diff.ratio >= kForceFullDiffRatio ||
           !prev_synced;
}

void EpdSsd1683::RunRefresh(bool full_refresh) {
    // 两条路径都先调 EpdInit() 做硬 reset + 寄存器初始化:
    // 1) full 路径里 EpdDisplayFull 自己会发 0xA5 切到 full 模式;
    // 2) partial 路径靠 EpdInit 把 EPD 拉回默认/partial 模式,否则上一轮
    //    full 留下的 0xA5 LUT 会让本轮 partial 视觉上变成全刷闪一下。
    EpdInit();
    if (full_refresh) {
        EpdDisplayFull();
        partial_since_full_ = 0;
        return;
    }

    partial_since_full_++;
    EpdDisplayPartial();
}

void EpdSsd1683::FinishRefreshSnapshot() {
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    memcpy(prev_snapshot_, snapshot_, kBufferLen);
    prev_snapshot_synced_ = true;
    refresh_in_progress_  = false;
    xSemaphoreGive(dirty_mutex_);
}

void EpdSsd1683::MarkRefreshIdle() {
    xSemaphoreTake(dirty_mutex_, portMAX_DELAY);
    refresh_in_progress_ = false;
    xSemaphoreGive(dirty_mutex_);
}

void EpdSsd1683::RefreshTaskLoop() {
    while (true) {
        // 第一次阻塞等 notify。来源:flush_cb / RequestUrgentXxxRefresh / 周期采样(已废)。
        if (ulTaskNotifyTake(pdTRUE, portMAX_DELAY) == 0)
            continue;

        if (RefreshTaskShouldStop())
            break;

        DebounceRefreshNotify();

        bool urgent     = false;
        bool force_full = false;
        if (!TakeRefreshRequest(urgent, force_full))
            break;

        if (!ThrottleRefreshSampling(urgent, force_full))
            continue;

        epd::DiffResult diff        = {};
        bool            prev_synced = false;
        if (!CaptureRefreshSnapshot(force_full, diff, prev_synced))
            continue;

        RunRefresh(ShouldUseFullRefresh(diff, force_full, prev_synced));

        // force_full_refresh_ 已在 start 处清(read-and-clear)。这里不要重设,
        // 否则会覆盖全刷期间又有新 RequestUrgentFullRefresh 设的 true。
        FinishRefreshSnapshot();
    }
    if (refresh_exit_)
        xSemaphoreGive(refresh_exit_);
    vTaskDelete(nullptr);
}
