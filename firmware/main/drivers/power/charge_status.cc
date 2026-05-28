#include "charge_status.h"

#include <driver/gpio.h>
#include <esp_err.h>
#include <esp_log.h>

#include <type_traits>

#include "config.h"

namespace {
constexpr char kTag[] = "Charge";
static_assert(std::is_same_v<std::underlying_type_t<ChargeStatus::State>, uint8_t>,
              "ChargeStatus::State must fit in the low 8 packed bits");
}  // namespace

void ChargeStatus::Init(gpio_num_t detect_gpio, gpio_num_t full_gpio, int64_t now_ms) {
    detect_gpio_ = detect_gpio;
    full_gpio_   = full_gpio;
    if (!callback_mutex_) {
        callback_mutex_ = xSemaphoreCreateMutex();
        if (!callback_mutex_) {
            ESP_LOGE(kTag, "Failed to create callback mutex");
            configASSERT(callback_mutex_ != nullptr);
        }
    }
    if (!tick_mutex_) {
        tick_mutex_ = xSemaphoreCreateMutex();
        if (!tick_mutex_) {
            ESP_LOGE(kTag, "Failed to create tick mutex");
            configASSERT(tick_mutex_ != nullptr);
        }
    }

    gpio_config_t cfg = {};
    cfg.intr_type     = GPIO_INTR_DISABLE;
    cfg.mode          = GPIO_MODE_INPUT;
    cfg.pin_bit_mask  = (1ULL << detect_gpio_) | (1ULL << full_gpio_);
    cfg.pull_up_en    = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&cfg));

    UpdateSnapshot(State::kNoPower, false, false);
    Tick(now_ms);
}

void ChargeStatus::OnStateChanged(std::function<void(const Snapshot&)> cb) {
    if (callback_mutex_)
        xSemaphoreTake(callback_mutex_, portMAX_DELAY);
    on_state_changed_ = cb;
    if (callback_mutex_)
        xSemaphoreGive(callback_mutex_);
}

void ChargeStatus::Tick(int64_t now_ms) {
    if (tick_mutex_)
        xSemaphoreTake(tick_mutex_, portMAX_DELAY);

    const bool charging_detected = gpio_get_level(detect_gpio_) == CHARGE_DETECT_CHARGING_LEVEL;
    const bool full_high         = gpio_get_level(full_gpio_) == 1;

    if (charging_detected) {
        last_power_present_ms_ = now_ms;
        last_detect_seen_ms_   = now_ms;
        if (detect_high_start_ms_ < 0) {
            detect_high_start_ms_ = now_ms;
        }
    } else {
        detect_high_start_ms_ = -1;
    }

    if (full_high) {
        last_power_present_ms_ = now_ms;
        last_full_seen_ms_     = now_ms;
        if (full_high_start_ms_ < 0) {
            full_high_start_ms_ = now_ms;
        }
    } else {
        full_high_start_ms_ = -1;
    }

    const bool power_present =
        (last_power_present_ms_ >= 0) && ((now_ms - last_power_present_ms_) <= kPowerPresentHoldMs);

    const bool detect_stable = (detect_high_start_ms_ >= 0) && ((now_ms - detect_high_start_ms_) >= kStableHighMs);
    const bool full_stable   = (full_high_start_ms_ >= 0) && ((now_ms - full_high_start_ms_) >= kStableHighMs);

    const bool alt_seen = power_present && (last_detect_seen_ms_ >= 0) && (last_full_seen_ms_ >= 0) &&
                          ((now_ms - last_detect_seen_ms_) <= kAltWindowMs) &&
                          ((now_ms - last_full_seen_ms_) <= kAltWindowMs);

    const bool no_battery = alt_seen && !detect_stable && !full_stable;

    // 状态优先级(从高到低):
    //   1. 没电源 → kNoPower
    //   2. 检测到无电池(两线 ~1Hz 交替) → kNoBattery
    //   3. CHRG_L 稳定低（明确「正在充电」信号） → kCharging
    //      ← 这一条必须比 kFull 优先,否则:充电 IC 的 STDBY 是 open-drain,
    //      没装外部上拉时浮空读 1 是常态,会被误判 full_stable=true → kFull,
    //      表现为充电中显示满电图标而不是 BOLT。
    //   4. STDBY 稳定高 → kFull
    //   5. 兜底:有电源但都不稳定 → kCharging
    State state = State::kNoPower;
    if (!power_present) {
        state = State::kNoPower;
    } else if (no_battery) {
        state = State::kNoBattery;
    } else if (detect_stable) {
        state = State::kCharging;
    } else if (full_stable) {
        state = State::kFull;
    } else {
        state = State::kCharging;
    }

    UpdateSnapshot(state, power_present, no_battery);

    if (tick_mutex_)
        xSemaphoreGive(tick_mutex_);
}

void ChargeStatus::UpdateSnapshot(State state, bool power_present, bool no_battery) {
    const bool     charging = (state == State::kCharging || state == State::kNoBattery);
    const bool     full     = (state == State::kFull);
    const uint32_t packed   = Pack(state, power_present, charging, full, no_battery);
    const uint32_t old      = snapshot_.exchange(packed, std::memory_order_relaxed);
    if (old != packed) {
        std::function<void(const Snapshot&)> cb;
        if (callback_mutex_)
            xSemaphoreTake(callback_mutex_, portMAX_DELAY);
        cb = on_state_changed_;
        if (callback_mutex_)
            xSemaphoreGive(callback_mutex_);
        if (cb)
            cb(Unpack(packed));
    }
}

uint32_t ChargeStatus::Pack(State state, bool power_present, bool charging, bool full, bool no_battery) {
    return (static_cast<uint32_t>(state) & 0xFFu) | ((power_present ? 1u : 0u) << 8) | ((charging ? 1u : 0u) << 9) |
           ((full ? 1u : 0u) << 10) | ((no_battery ? 1u : 0u) << 11);
}

ChargeStatus::Snapshot ChargeStatus::Unpack(uint32_t v) {
    Snapshot s{};
    s.state         = static_cast<State>(v & 0xFF);
    s.power_present = (v >> 8) & 0x1;
    s.charging      = (v >> 9) & 0x1;
    s.full          = (v >> 10) & 0x1;
    s.no_battery    = (v >> 11) & 0x1;
    return s;
}

ChargeStatus::Snapshot ChargeStatus::Get() const {
    return Unpack(snapshot_.load(std::memory_order_relaxed));
}
