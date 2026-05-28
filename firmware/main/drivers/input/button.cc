#include "button.h"

#include <button_gpio.h>
#include <esp_log.h>

namespace {
constexpr char kTag[] = "Button";
}

#if CONFIG_SOC_ADC_SUPPORTED
AdcButton::AdcButton(const button_adc_config_t& adc_config) : Button(nullptr) {
    button_config_t btn_config = {
        .long_press_time  = 2000,
        .short_press_time = 0,
    };
    ESP_ERROR_CHECK(iot_button_new_adc_device(&btn_config, &adc_config, &button_handle_));
}
#endif

Button::Button(button_handle_t button_handle) : button_handle_(button_handle) {
}

Button::Button(gpio_num_t gpio_num, bool active_high, uint16_t long_press_time, uint16_t short_press_time,
               bool enable_power_save)
    : gpio_num_(gpio_num) {
    if (gpio_num == GPIO_NUM_NC) {
        return;
    }
    button_config_t      button_config = {.long_press_time = long_press_time, .short_press_time = short_press_time};
    button_gpio_config_t gpio_config   = {.gpio_num          = gpio_num,
                                          .active_level      = static_cast<uint8_t>(active_high ? 1 : 0),
                                          .enable_power_save = enable_power_save,
                                          .disable_pull      = false};
    ESP_ERROR_CHECK(iot_button_new_gpio_device(&button_config, &gpio_config, &button_handle_));
}

Button::~Button() {
    if (button_handle_ != nullptr) {
        iot_button_delete(button_handle_);
    }
}

bool Button::RegisterCallback(button_event_t event, button_event_args_t* args, button_cb_t cb, void* user_data,
                              bool& registered) {
    if (button_handle_ == nullptr) {
        return false;
    }
    if (registered) {
        esp_err_t err = iot_button_unregister_cb(button_handle_, event, args);
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "unregister event %d failed: %s", static_cast<int>(event), esp_err_to_name(err));
            return false;
        }
        registered = false;
    }
    esp_err_t err = iot_button_register_cb(button_handle_, event, args, cb, user_data);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "register event %d failed: %s", static_cast<int>(event), esp_err_to_name(err));
        return false;
    }
    registered = true;
    return true;
}

void Button::OnPressDown(std::function<void()> callback) {
    if (button_handle_ == nullptr) {
        return;
    }
    on_press_down_ = callback;
    RegisterCallback(
        BUTTON_PRESS_DOWN, nullptr,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_press_down_) {
                button->on_press_down_();
            }
        },
        this, press_down_registered_);
}

void Button::OnPressUp(std::function<void()> callback) {
    if (button_handle_ == nullptr) {
        return;
    }
    on_press_up_ = callback;
    RegisterCallback(
        BUTTON_PRESS_UP, nullptr,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_press_up_) {
                button->on_press_up_();
            }
        },
        this, press_up_registered_);
}

void Button::OnLongPress(std::function<void()> callback) {
    if (button_handle_ == nullptr) {
        return;
    }
    on_long_press_ = callback;
    RegisterCallback(
        BUTTON_LONG_PRESS_START, nullptr,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_long_press_) {
                button->on_long_press_();
            }
        },
        this, long_press_registered_);
}

void Button::OnClick(std::function<void()> callback) {
    if (button_handle_ == nullptr) {
        return;
    }
    on_click_ = callback;
    RegisterCallback(
        BUTTON_SINGLE_CLICK, nullptr,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_click_) {
                button->on_click_();
            }
        },
        this, click_registered_);
}

void Button::OnDoubleClick(std::function<void()> callback) {
    if (button_handle_ == nullptr) {
        return;
    }
    on_double_click_ = callback;
    RegisterCallback(
        BUTTON_DOUBLE_CLICK, nullptr,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_double_click_) {
                button->on_double_click_();
            }
        },
        this, double_click_registered_);
}

void Button::OnMultipleClick(std::function<void()> callback, uint8_t click_count) {
    if (button_handle_ == nullptr) {
        return;
    }
    if (multiple_click_registered_) {
        button_event_args_t old_args = {.multiple_clicks = {.clicks = multiple_click_count_}};
        esp_err_t           err      = iot_button_unregister_cb(button_handle_, BUTTON_MULTIPLE_CLICK, &old_args);
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "unregister event %d failed: %s", static_cast<int>(BUTTON_MULTIPLE_CLICK),
                     esp_err_to_name(err));
            return;
        }
        multiple_click_registered_ = false;
    }
    on_multiple_click_             = callback;
    multiple_click_count_          = click_count;
    button_event_args_t event_args = {.multiple_clicks = {.clicks = multiple_click_count_}};
    RegisterCallback(
        BUTTON_MULTIPLE_CLICK, &event_args,
        [](void* handle, void* usr_data) {
            Button* button = static_cast<Button*>(usr_data);
            if (button->on_multiple_click_) {
                button->on_multiple_click_();
            }
        },
        this, multiple_click_registered_);
}
