#pragma once

#include <button_adc.h>
#include <button_gpio.h>
#include <button_types.h>
#include <driver/gpio.h>
#include <iot_button.h>
#include <functional>

class Button {
   public:
    Button(button_handle_t button_handle);
    Button(gpio_num_t gpio_num, bool active_high = false, uint16_t long_press_time = 0, uint16_t short_press_time = 0,
           bool enable_power_save = false);
    ~Button();

    void OnPressDown(std::function<void()> callback);
    void OnPressUp(std::function<void()> callback);
    void OnLongPress(std::function<void()> callback);
    void OnClick(std::function<void()> callback);
    void OnDoubleClick(std::function<void()> callback);
    void OnMultipleClick(std::function<void()> callback, uint8_t click_count = 3);

   protected:
    gpio_num_t      gpio_num_      = GPIO_NUM_NC;
    button_handle_t button_handle_ = nullptr;

    bool RegisterCallback(button_event_t event, button_event_args_t* args, button_cb_t cb, void* user_data,
                          bool& registered);

    std::function<void()> on_press_down_;
    std::function<void()> on_press_up_;
    std::function<void()> on_long_press_;
    std::function<void()> on_click_;
    std::function<void()> on_double_click_;
    std::function<void()> on_multiple_click_;

    bool    press_down_registered_     = false;
    bool    press_up_registered_       = false;
    bool    long_press_registered_     = false;
    bool    click_registered_          = false;
    bool    double_click_registered_   = false;
    bool    multiple_click_registered_ = false;
    uint8_t multiple_click_count_      = 0;
};

#if CONFIG_SOC_ADC_SUPPORTED
class AdcButton : public Button {
   public:
    AdcButton(const button_adc_config_t& adc_config);
};
#endif

class PowerSaveButton : public Button {
   public:
    PowerSaveButton(gpio_num_t gpio_num) : Button(gpio_num, false, 0, 0, true) {
    }
};
