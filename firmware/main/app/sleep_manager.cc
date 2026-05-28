#include "sleep_manager.h"

#include <driver/rtc_io.h>
#include <esp_log.h>
#include <esp_sleep.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <array>

#include "audio_player.h"
#include "board.h"
#include "charge_status.h"
#include "config.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "gpio_util.h"
#include "power_state.h"
#include "sync_service.h"
#include "xiaozhi_chat_service.h"

namespace {
constexpr char kTag[] = "Sleep";

// 进 deep sleep 前等 EPD 刷新结束的最大时长。低温或 full cleanup 可接近 5s；
// 超时过短会在白相阶段切 EPD 电源，留下整屏白。
constexpr int kEpdFlushTimeoutMs = 8000;

constexpr uint32_t kUnboundFlag      = 1UL << 31;
constexpr uint32_t kBatteryShift     = 24;
constexpr uint32_t kBatteryMask      = 0x7FUL << kBatteryShift;
constexpr uint32_t kUnboundSinceMask = (1UL << kBatteryShift) - 1;
constexpr int      kMaxPackedBattery = 100;
constexpr int      kMinPackedBattery = 0;

int ClampBatteryPct(int pct) {
    if (pct < kMinPackedBattery)
        return kMinPackedBattery;
    if (pct > kMaxPackedBattery)
        return kMaxPackedBattery;
    return pct;
}

uint32_t ClampSinceSec(int64_t since_ms) {
    if (since_ms <= 0)
        return 0;
    return static_cast<uint32_t>((since_ms / 1000) & kUnboundSinceMask);
}

uint32_t PackUnboundState(bool unbound, int battery_pct, int64_t since_ms) {
    const uint32_t flag    = unbound ? kUnboundFlag : 0;
    const uint32_t battery = static_cast<uint32_t>(ClampBatteryPct(battery_pct)) << kBatteryShift;
    const uint32_t since   = ClampSinceSec(since_ms);
    return flag | battery | since;
}

bool UnboundFromPacked(uint32_t packed) {
    return (packed & kUnboundFlag) != 0;
}

int BatteryFromPacked(uint32_t packed) {
    return static_cast<int>((packed & kBatteryMask) >> kBatteryShift);
}

int64_t SinceMsFromPacked(uint32_t packed) {
    return static_cast<int64_t>(packed & kUnboundSinceMask) * 1000;
}

int64_t ElapsedSincePackedMs(int64_t now_ms, uint32_t packed) {
    const uint32_t now_sec   = static_cast<uint32_t>((now_ms / 1000) & kUnboundSinceMask);
    const uint32_t since_sec = packed & kUnboundSinceMask;
    return static_cast<int64_t>((now_sec - since_sec) & kUnboundSinceMask) * 1000;
}

template <typename Transform>
void UpdateUnboundState(std::atomic<uint32_t>& state, Transform transform) {
    uint32_t cur = state.load(std::memory_order_acquire);
    while (true) {
        const uint32_t next = transform(cur);
        if (state.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            return;
    }
}

bool MarkUnboundIfNeeded(std::atomic<uint32_t>& state, int64_t now_ms) {
    uint32_t cur = state.load(std::memory_order_acquire);
    while (true) {
        if (UnboundFromPacked(cur))
            return false;
        const uint32_t next = PackUnboundState(true, BatteryFromPacked(cur), now_ms);
        if (state.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            return true;
    }
}

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

void SaveStatusBarSnapshot(EpdSsd1683* epd) {
    if (!epd)
        return;
    std::array<uint8_t, power_state::kStatusBarSnapshotBytes> snapshot{};
    if (!epd->ReadPreviousRaw1bpp(0, 0, power_state::kStatusBarSnapshotWidth, power_state::kStatusBarSnapshotHeight,
                                  snapshot.data(), snapshot.size())) {
        ESP_LOGW(kTag, "Status bar snapshot skipped: previous buffer not synced");
        power_state::ClearStatusBarSnapshot();
        return;
    }
    power_state::SaveStatusBarSnapshot(snapshot.data(), snapshot.size());
}

}  // namespace

void SleepManager::Init(Policy p) {
    idle_timeout_min_ = p.idle_timeout_min;
    unbound_grace_ms_ = p.unbound_grace_ms;
    low_battery_pct_  = p.low_battery_pct;
    last_active_ms_.store(esp_timer_get_time() / 1000);
    unbound_state_.store(PackUnboundState(false, kMaxPackedBattery, 0), std::memory_order_release);
    enabled_.store(!p.disabled);
}

void SleepManager::Disable() {
    enabled_.store(false);
}

void SleepManager::OnEvent(const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
        case UiEventKind::kButtonLong:
        case UiEventKind::kButtonDouble:
            last_active_ms_.store(esp_timer_get_time() / 1000);
            break;
        case UiEventKind::kChargeChanged:
            paused_.store(e.u.charge.present);
            if (e.u.charge.present) {
                last_active_ms_.store(esp_timer_get_time() / 1000);
            }
            break;
        case UiEventKind::kBound:
            UpdateUnboundState(unbound_state_,
                               [](uint32_t cur) { return PackUnboundState(false, BatteryFromPacked(cur), 0); });
            break;
        case UiEventKind::kUnbound:
            // 仅首次进入 unbound 时记录起始 ts,重复事件不重置(否则 2h 兜底永不触发)。
            if (MarkUnboundIfNeeded(unbound_state_, esp_timer_get_time() / 1000)) {
                ESP_LOGW(kTag, "Unbound -> deep sleep blocked for up to %lld h",
                         (long long)(kUnboundGraceMs / (60 * 60 * 1000)));
            }
            break;
        case UiEventKind::kBatteryUpdated:
            UpdateUnboundState(unbound_state_, [pct = e.u.battery.pct](uint32_t cur) {
                return PackUnboundState(UnboundFromPacked(cur), pct, SinceMsFromPacked(cur));
            });
            break;
        default:
            break;
    }
}

bool SleepManager::InUnboundGrace(int64_t now_ms) const {
    const uint32_t state = unbound_state_.load(std::memory_order_acquire);
    if (!UnboundFromPacked(state))
        return false;
    if (BatteryFromPacked(state) < low_battery_pct_)
        return false;
    return ElapsedSincePackedMs(now_ms, state) < unbound_grace_ms_;
}

uint32_t SleepManager::ComputeConfiguredNextWakeSec() const {
    return power_state::ComputeNextWakeSec();
}

void SleepManager::Tick(int64_t now_ms) {
    if (!enabled_.load())
        return;
    if (paused_.load())
        return;
    if (xiaozhi::ChatService::Get().BlocksSleep())
        return;
    if (InUnboundGrace(now_ms))
        return;
    const int64_t idle_ms      = now_ms - last_active_ms_.load();
    const int64_t threshold_ms = static_cast<int64_t>(idle_timeout_min_) * 60 * 1000;
    if (idle_ms < threshold_ms)
        return;
    ESP_LOGW(kTag, "Idle %lldms >= %lldms -> entering deep sleep", (long long)idle_ms, (long long)threshold_ms);
    const auto decision = TryEnterDeepSleep();
    if (decision.outcome != SleepOutcome::kSlept) {
        // TryEnterDeepSleep can be refused by charge/unbound/disabled guards. Treat
        // that refusal as activity so Tick() does not spin the full sleep path every second.
        last_active_ms_.store(now_ms);
    }
}

SleepManager::SleepDecision SleepManager::TryEnterDeepSleep() {
    power_state::RestoreCurrentFrameScheduleFromCache();
    const uint32_t next_sec = ComputeConfiguredNextWakeSec();
    if (!enabled_.load()) {
        return {SleepOutcome::kDisabled, next_sec};
    }
    const int64_t now_ms = esp_timer_get_time() / 1000;
    if (InUnboundGrace(now_ms)) {
        return {SleepOutcome::kUnboundGrace, next_sec};
    }
    // paused_ 由 kChargeChanged 事件驱动,timer wake 路径下可能尚未消化此事件。
    // 同时现场查询硬件确保新插入的电源也能即时拦截。
    const bool power_present = Board::Get().charge()->Get().power_present;
    if (power_present || paused_.load()) {
        if (power_present)
            paused_.store(true);
        return {SleepOutcome::kPausedByCharge, next_sec};
    }
    ESP_LOGW(kTag, "EnterDeepSleep: shutting down peripherals");

    // 1) 停后台 task,避免在 rail 关闭后还有 I²C / 网络写操作。
    //    Stop 是异步信号 task 自然退出,不等(esp_deep_sleep_start 强制中断)。
    xiaozhi::ChatService::Get().SuspendForSleep();
    SyncService::Get().Stop();
    AudioPlayer::Get().Stop();

    // 2) 只等待已有 EPD 刷新完成，不主动制造一轮全刷。墨水屏内容本来可保留；
    //    静态帧 idle 进睡眠时如果这里再全刷一次，会白白耗电。
    if (auto* epd = Board::Get().epd()) {
        const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(kEpdFlushTimeoutMs);
        while (epd->IsRefreshPending() && xTaskGetTickCount() < deadline) {
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        if (epd->IsRefreshPending()) {
            ESP_LOGW(kTag, "EPD still pending after %dms; skip status bar snapshot", kEpdFlushTimeoutMs);
            power_state::ClearStatusBarSnapshot();
        } else {
            SaveStatusBarSnapshot(epd);
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
    PrepareWakeupGpio(static_cast<gpio_num_t>(BOOT_BUTTON_GPIO));    // ENTER
    PrepareWakeupGpio(static_cast<gpio_num_t>(DOWN_BUTTON_GPIO));    // 下键(GPIO 39 UP 不是 RTC IO 用不了)
    PrepareWakeupGpio(static_cast<gpio_num_t>(CHARGE_DETECT_GPIO));  // 插 USB 自动唤醒

    constexpr uint64_t kWakeupMask =
        (1ULL << BOOT_BUTTON_GPIO) | (1ULL << DOWN_BUTTON_GPIO) | (1ULL << CHARGE_DETECT_GPIO);
    esp_sleep_enable_ext1_wakeup(kWakeupMask, ESP_EXT1_WAKEUP_ANY_LOW);

    // 7) RTC timer 只服务当前动态帧。静态帧不会自己变更，靠 timer wake
    //    周期性联网只会空耗电；远端静态内容变化等用户按键/插电唤醒后再同步。
    if (next_sec > 0) {
        esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(next_sec) * 1'000'000ULL);
        ESP_LOGW(kTag, "ESP deep_sleep_start (mask=0x%llx, timer=%us)", (unsigned long long)kWakeupMask,
                 static_cast<unsigned>(next_sec));
    } else {
        ESP_LOGW(kTag, "ESP deep_sleep_start (mask=0x%llx, timer=off)", (unsigned long long)kWakeupMask);
    }
    esp_deep_sleep_start();
    __builtin_unreachable();
}
