#include "drivers/input/up_down_combo.h"

void UpDownComboController::Install(const ButtonInput& up, const ButtonInput& down, std::function<void()> on_combo,
                                 std::function<void()> on_up_short, std::function<void()> on_up_long,
                                 std::function<void()> on_down_short, std::function<void()> on_down_long) {
    on_combo_ = std::move(on_combo);
    if (!up.IsValid() || !down.IsValid())
        return;

    up.on_press_down([this] {
        Update(kComboUpHeld, kComboUpConsumed);
        TryFire();
    });
    up.on_press_up([this] { Update(0, kComboUpHeld); });
    up.on_click([this, cb = std::move(on_up_short)] {
        if (Bit(kComboUpConsumed))
            return;
        if (cb)
            cb();
    });
    up.on_long_press([this, cb = std::move(on_up_long)] {
        if (Bit(kComboUpConsumed))
            return;
        if (cb)
            cb();
    });

    down.on_press_down([this] {
        Update(kComboDownHeld, kComboDownConsumed);
        TryFire();
    });
    down.on_press_up([this] { Update(0, kComboDownHeld); });
    down.on_click([this, cb = std::move(on_down_short)] {
        if (Bit(kComboDownConsumed))
            return;
        if (cb)
            cb();
    });
    down.on_long_press([this, cb = std::move(on_down_long)] {
        if (Bit(kComboDownConsumed))
            return;
        if (cb)
            cb();
    });
}

void UpDownComboController::Update(uint8_t set_bits, uint8_t clear_bits) {
    uint8_t cur = state_.load(std::memory_order_acquire);
    while (true) {
        const uint8_t next = (cur | set_bits) & static_cast<uint8_t>(~clear_bits);
        if (state_.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            return;
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
        if (!both_held || consumed)
            return;
        const uint8_t next = cur | kComboUpConsumed | kComboDownConsumed;
        if (state_.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            break;
    }
    if (on_combo_)
        on_combo_();
}
