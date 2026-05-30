#pragma once

#include <atomic>
#include <functional>

class Button;

class ComboKeyController {
   public:
    void Install(Button* up, Button* down, std::function<void()> on_combo, std::function<void()> on_up_short,
                 std::function<void()> on_up_long, std::function<void()> on_down_short,
                 std::function<void()> on_down_long);

   private:
    static constexpr uint8_t kComboUpHeld       = 1u << 0;
    static constexpr uint8_t kComboDownHeld     = 1u << 1;
    static constexpr uint8_t kComboUpConsumed   = 1u << 2;
    static constexpr uint8_t kComboDownConsumed = 1u << 3;

    void Update(uint8_t set_bits, uint8_t clear_bits);
    bool Bit(uint8_t bit) const;
    void TryFire();

    std::atomic<uint8_t>  state_{0};
    std::function<void()> on_combo_;
};
