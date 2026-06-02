#include "drivers/input/up_down_combo.h"

#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace {
constexpr char kTag[] = "up_down_combo";

void LogState(const char* action, uint8_t state) {
    ESP_LOGD(kTag, "state action=%s state=0x%02x up_held=%d down_held=%d up_consumed=%d down_consumed=%d", action,
             static_cast<unsigned>(state), (state & UpDownComboController::kComboUpHeld) ? 1 : 0,
             (state & UpDownComboController::kComboDownHeld) ? 1 : 0,
             (state & UpDownComboController::kComboUpConsumed) ? 1 : 0,
             (state & UpDownComboController::kComboDownConsumed) ? 1 : 0);
}
}  // namespace

void UpDownComboController::Install(const ButtonInput& up, const ButtonInput& down, std::function<void()> on_combo,
                                    std::function<void()> on_up_short, std::function<void()> on_up_long,
                                    std::function<void()> on_down_short, std::function<void()> on_down_long) {
    on_combo_ = std::move(on_combo);
    ESP_LOGD(kTag, "install up_valid=%d down_valid=%d", up.IsValid() ? 1 : 0, down.IsValid() ? 1 : 0);
    if (!up.IsValid() || !down.IsValid())
        return;

    up.on_press_down([this] {
        ESP_LOGD(kTag, "press down btn=up tick=%lu", static_cast<unsigned long>(xTaskGetTickCount()));
        Update(kComboUpHeld, kComboUpConsumed);
        TryFire();
    });
    up.on_press_up([this] {
        ESP_LOGD(kTag, "press up btn=up tick=%lu", static_cast<unsigned long>(xTaskGetTickCount()));
        Update(0, kComboUpHeld);
    });
    up.on_click([this, cb = std::move(on_up_short)] {
        if (Bit(kComboUpConsumed)) {
            ESP_LOGD(kTag, "click consumed btn=up type=short");
            return;
        }
        ESP_LOGD(kTag, "click dispatch btn=up type=short");
        if (cb)
            cb();
    });
    up.on_long_press([this, cb = std::move(on_up_long)] {
        if (Bit(kComboUpConsumed)) {
            ESP_LOGD(kTag, "click consumed btn=up type=long");
            return;
        }
        ESP_LOGD(kTag, "click dispatch btn=up type=long");
        if (cb)
            cb();
    });

    down.on_press_down([this] {
        ESP_LOGD(kTag, "press down btn=down tick=%lu", static_cast<unsigned long>(xTaskGetTickCount()));
        Update(kComboDownHeld, kComboDownConsumed);
        TryFire();
    });
    down.on_press_up([this] {
        ESP_LOGD(kTag, "press up btn=down tick=%lu", static_cast<unsigned long>(xTaskGetTickCount()));
        Update(0, kComboDownHeld);
    });
    down.on_click([this, cb = std::move(on_down_short)] {
        if (Bit(kComboDownConsumed)) {
            ESP_LOGD(kTag, "click consumed btn=down type=short");
            return;
        }
        ESP_LOGD(kTag, "click dispatch btn=down type=short");
        if (cb)
            cb();
    });
    down.on_long_press([this, cb = std::move(on_down_long)] {
        if (Bit(kComboDownConsumed)) {
            ESP_LOGD(kTag, "click consumed btn=down type=long");
            return;
        }
        ESP_LOGD(kTag, "click dispatch btn=down type=long");
        if (cb)
            cb();
    });
}

void UpDownComboController::Update(uint8_t set_bits, uint8_t clear_bits) {
    uint8_t cur = state_.load(std::memory_order_acquire);
    while (true) {
        const uint8_t next = (cur | set_bits) & static_cast<uint8_t>(~clear_bits);
        if (state_.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire)) {
            LogState("update", next);
            return;
        }
    }
}

bool UpDownComboController::Bit(uint8_t bit) const {
    return (state_.load(std::memory_order_acquire) & bit) != 0;
}

void UpDownComboController::TryFire() {
    uint8_t cur = state_.load(std::memory_order_acquire);
    while (true) {
        const bool both_held = (cur & (kComboUpHeld | kComboDownHeld)) == (kComboUpHeld | kComboDownHeld);
        const bool consumed =
            (cur & (kComboUpConsumed | kComboDownConsumed)) == (kComboUpConsumed | kComboDownConsumed);
        if (!both_held || consumed) {
            ESP_LOGD(kTag, "try fire skip state=0x%02x both_held=%d consumed=%d", static_cast<unsigned>(cur),
                     both_held ? 1 : 0, consumed ? 1 : 0);
            return;
        }
        const uint8_t next = cur | kComboUpConsumed | kComboDownConsumed;
        if (state_.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            break;
    }
    ESP_LOGD(kTag, "combo fired");
    if (on_combo_)
        on_combo_();
}
