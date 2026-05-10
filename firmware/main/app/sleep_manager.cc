#include "sleep_manager.h"

#include <driver/rtc_io.h>
#include <esp_log.h>
#include <esp_sleep.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "../audio/audio_player.h"
#include "../display/epd_ssd1683.h"
#include "../hal/config.h"
#include "../hal/gpio_util.h"
#include "../net/sync_service.h"
#include "board.h"
#include "event_bus.h"

namespace {
constexpr char kTag[] = "Sleep";

// 30 分钟兜底定时器唤醒。**防变砖核心**:
// 万一 EXT1 配置错 / 按键焊点松 / hold 失效,timer 也能把设备捞起来。
// 与参考实现 esp32-eink/.../zectrix-s3-epaper-4.2.cc:288 一致。
constexpr uint64_t kFallbackTimerUs = 30ULL * 60 * 1000 * 1000;

// 进 deep sleep 前等 EPD 刷新结束的最大时长。EPD 全刷 2-4s。
constexpr int kEpdFlushTimeoutMs = 4000;

// 把单个 GPIO 配成 RTC 数字输入 + 上拉 + hold,适合做 EXT1 ANY_LOW 唤醒源。
// 必须用 rtc_gpio_set_direction —— 仅 rtc_gpio_init 不改 direction,GPIO 仍可能
// 处于 ADC/iot_button 之前留下的非数字输入态,EXT1 感知不到电平。
void PrepareWakeupGpio(gpio_num_t pin) {
    rtc_gpio_init(pin);
    rtc_gpio_set_direction(pin, RTC_GPIO_MODE_INPUT_ONLY);
    rtc_gpio_pulldown_dis(pin);
    rtc_gpio_pullup_en(pin);
    rtc_gpio_hold_en(pin);
}

// VBAT_PWR (GPIO17) 是软锁存,拉低=整机断电(BOOT 唤醒无效=变砖)。
// ESP_SLEEP_GPIO_RESET_WORKAROUND 开了后,普通 GPIO 在 deep sleep 期间会被
// 强制复位。必须切到 RTC GPIO 域、显式 rtc_gpio_hold_en 才能真正 hold 高电平。
void LockVbatPowerHigh() {
    auto pin = static_cast<gpio_num_t>(VBAT_PWR_PIN);
    gpio_hold_dis(pin);  // 先释放普通 GPIO 域 hold,RTC GPIO 才能接管
    rtc_gpio_init(pin);
    rtc_gpio_set_direction(pin, RTC_GPIO_MODE_OUTPUT_ONLY);
    rtc_gpio_pulldown_dis(pin);
    rtc_gpio_pullup_dis(pin);
    rtc_gpio_set_level(pin, 1);
    rtc_gpio_hold_en(pin);
}

}  // namespace

void SleepManager::Init(int idle_timeout_min) {
    idle_timeout_min_ = idle_timeout_min;
    last_active_ms_.store(esp_timer_get_time() / 1000);
    enabled_.store(true);
    ESP_LOGI(kTag, "Deep sleep idle timeout: %d min", idle_timeout_min);
}

void SleepManager::Disable() {
    enabled_.store(false);
    ESP_LOGI(kTag, "Deep sleep disabled");
}

void SleepManager::OnEvent(const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
        case UiEventKind::kButtonLong:
        case UiEventKind::kSyncStarted:
        case UiEventKind::kSyncFinished:
        case UiEventKind::kGroupReady:
            last_active_ms_.store(esp_timer_get_time() / 1000);
            break;
        case UiEventKind::kChargeChanged:
            paused_.store(e.u.charge.present);
            if (e.u.charge.present) {
                last_active_ms_.store(esp_timer_get_time() / 1000);
            }
            break;
        default:
            break;
    }
}

void SleepManager::Tick(int64_t now_ms) {
    if (!enabled_.load()) return;
    if (paused_.load()) return;
    const int64_t idle_ms      = now_ms - last_active_ms_.load();
    const int64_t threshold_ms = static_cast<int64_t>(idle_timeout_min_) * 60 * 1000;
    if (idle_ms < threshold_ms) return;
    ESP_LOGW(kTag, "Idle %lldms >= %lldms -> entering deep sleep",
             (long long)idle_ms, (long long)threshold_ms);
    EnterDeepSleep();
}

void SleepManager::EnterDeepSleep() {
    ESP_LOGW(kTag, "EnterDeepSleep: shutting down peripherals");

    // 0) 让上层(App)在进睡前最后更新一次 UI 状态 — 比如把状态栏 wifi 图标
    //    改成「断开」，免得屏上留个「已连接」的过期画面误导用户。
    if (pre_sleep_hook_) pre_sleep_hook_();

    // 1) 停后台 task,避免在 rail 关闭后还有 I²C / 网络写操作。
    //    Stop 是异步信号 task 自然退出,不等(esp_deep_sleep_start 强制中断)。
    SyncService::Get().Stop();
    AudioPlayer::Get().Stop();

    // 2) 强制 EPD 全屏刷一次 + 等传输完成。EPD 刷新 2-4s,中途断电会卡半截画面。
    //    deadline 兜底,极端情况(屏挂)最多等 4s。
    if (auto* epd = Board::Get().epd()) {
        epd->RequestUrgentFullRefresh();
        const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kEpdFlushTimeoutMs);
        while (epd->IsRefreshPending() && xTaskGetTickCount() < deadline) {
            vTaskDelay(pdMS_TO_TICKS(50));
        }
    }

    // 3) 关 EPD rail (GPIO6)。墨水屏像素双稳态保留,controller 寄存器/电荷泵失效,
    //    醒来 EpdInit 重做时序就好。
    GpioWriteHold(EPD_PWR_PIN, 0);

    // 4) 关 audio rail (GPIO42)。**必须在 I²C 操作完成之后**:这条 rail 一关,
    //    R45/R46 上拉死,后续任何 I²C 都失败。NVS / 其他后台任务清理已在前面完成。
    GpioWriteHold(AUDIO_PWR_PIN, 0);

    // 5) **关键防变砖**:VBAT_PWR (GPIO17) 必须保持高,否则整机断电,BOOT 也唤不醒。
    //    用 RTC GPIO API 切到 RTC 域显式 hold,绕开 GPIO_RESET_WORKAROUND。
    LockVbatPowerHigh();

    // 6) 配置 EXT1 唤醒源 GPIO,iot_button 之前占用过 GPIO0/18 的 IO MUX,
    //    必须 rtc_gpio_set_direction(INPUT_ONLY) 复位回数字输入,EXT1 才能感知。
    PrepareWakeupGpio(static_cast<gpio_num_t>(BOOT_BUTTON_GPIO));   // ENTER
    PrepareWakeupGpio(static_cast<gpio_num_t>(DOWN_BUTTON_GPIO));   // 下键(GPIO 39 UP 不是 RTC IO 用不了)
    PrepareWakeupGpio(static_cast<gpio_num_t>(CHARGE_DETECT_GPIO)); // 插 USB 自动唤醒

    constexpr uint64_t kWakeupMask = (1ULL << BOOT_BUTTON_GPIO)
                                   | (1ULL << DOWN_BUTTON_GPIO)
                                   | (1ULL << CHARGE_DETECT_GPIO);
    esp_sleep_enable_ext1_wakeup(kWakeupMask, ESP_EXT1_WAKEUP_ANY_LOW);

    // 7) **30 分钟兜底定时器**:防一切外部唤醒源失效时永久睡死(变砖)。
    //    宁可白白醒一次也别让设备睡死收不回来。
    esp_sleep_enable_timer_wakeup(kFallbackTimerUs);

    ESP_LOGW(kTag, "ESP deep_sleep_start (mask=0x%llx, timer=%llus)",
             (unsigned long long)kWakeupMask,
             (unsigned long long)(kFallbackTimerUs / 1000000ULL));
    esp_deep_sleep_start();
    // 不返回
}
