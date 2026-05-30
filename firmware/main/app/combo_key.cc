#include "combo_key.h"

#include "button.h"

void ComboKeyController::Install(Button* up, Button* down, std::function<void()> on_combo,
                                 std::function<void()> on_up_short, std::function<void()> on_up_long,
                                 std::function<void()> on_down_short, std::function<void()> on_down_long) {
    on_combo_ = std::move(on_combo);
    if (!up || !down)
        return;

    up->OnPressDown([this] {
        Update(kComboUpHeld, kComboUpConsumed);
        TryFire();
    });
    up->OnPressUp([this] { Update(0, kComboUpHeld); });
    up->OnClick([this, cb = std::move(on_up_short)] {
        if (Bit(kComboUpConsumed))
            return;
        if (cb)
            cb();
    });
    up->OnLongPress([this, cb = std::move(on_up_long)] {
        if (Bit(kComboUpConsumed))
            return;
        if (cb)
            cb();
    });

    down->OnPressDown([this] {
        Update(kComboDownHeld, kComboDownConsumed);
        TryFire();
    });
    down->OnPressUp([this] { Update(0, kComboDownHeld); });
    down->OnClick([this, cb = std::move(on_down_short)] {
        if (Bit(kComboDownConsumed))
            return;
        if (cb)
            cb();
    });
    down->OnLongPress([this, cb = std::move(on_down_long)] {
        if (Bit(kComboDownConsumed))
            return;
        if (cb)
            cb();
    });
}

void ComboKeyController::Update(uint8_t set_bits, uint8_t clear_bits) {
    uint8_t cur = state_.load(std::memory_order_acquire);
    while (true) {
        const uint8_t next = (cur | set_bits) & static_cast<uint8_t>(~clear_bits);
        if (state_.compare_exchange_weak(cur, next, std::memory_order_acq_rel, std::memory_order_acquire))
            return;
    }
}

bool ComboKeyController::Bit(uint8_t bit) const {
    return (state_.load(std::memory_order_acquire) & bit) != 0;
}

void ComboKeyController::TryFire() {
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
