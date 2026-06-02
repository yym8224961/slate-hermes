#include "drivers/bus/i2c_device.h"

#include <esp_log.h>

#include "drivers/bus/i2c_bus_lock.h"

namespace {
constexpr char kTag[] = "i2c_device";
}

extern "C" void __attribute__((weak)) BoardI2cForcePowerOn() {
}

constexpr int kI2cTimeoutMs = 100;

I2cDevice::I2cDevice(i2c_master_bus_handle_t i2c_bus, uint8_t addr) : i2c_bus_(i2c_bus), device_address_(addr) {
    ScopedI2cBusLock bus_lock("I2cDevice::I2cDevice");
    ESP_ERROR_CHECK(bus_lock.status());
    ESP_ERROR_CHECK(AddDeviceLocked());
}

esp_err_t I2cDevice::AddDeviceLocked() {
    i2c_device_config_t i2c_device_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = device_address_,
        .scl_speed_hz    = 400 * 1000,
        .scl_wait_us     = 0,
        .flags =
            {
                .disable_ack_check = 0,
            },
    };
    return i2c_master_bus_add_device(i2c_bus_, &i2c_device_cfg, &i2c_device_);
}

esp_err_t I2cDevice::RecreateDeviceLocked() {
    if (i2c_device_) {
        esp_err_t rm = i2c_master_bus_rm_device(i2c_device_);
        if (rm != ESP_OK) {
            ESP_LOGW(kTag, "remove device failed addr=0x%02x err=%s", static_cast<unsigned>(device_address_),
                     esp_err_to_name(rm));
        }
        i2c_device_ = nullptr;
    }
    esp_err_t add = AddDeviceLocked();
    if (add != ESP_OK) {
        ESP_LOGW(kTag, "add device failed addr=0x%02x err=%s", static_cast<unsigned>(device_address_),
                 esp_err_to_name(add));
    }
    return add;
}

esp_err_t I2cDevice::ResetBus(const char* reason) {
    ScopedI2cBusLock bus_lock("I2cDevice::ResetBus");
    if (!bus_lock.locked()) {
        return bus_lock.status();
    }
    ESP_LOGW(kTag, "bus reset reason=%s addr=0x%02x", reason ? reason : "unknown",
             static_cast<unsigned>(device_address_));
    const esp_err_t reset_ret = i2c_master_bus_reset(i2c_bus_);
    const esp_err_t add_ret   = RecreateDeviceLocked();
    return reset_ret == ESP_OK ? add_ret : reset_ret;
}

esp_err_t I2cDevice::WriteReg(uint8_t reg, uint8_t value) {
    ScopedI2cBusLock bus_lock("I2cDevice::WriteReg");
    if (!bus_lock.locked()) {
        return bus_lock.status();
    }
    uint8_t buffer[2] = {reg, value};
    BoardI2cForcePowerOn();
    esp_err_t ret = i2c_master_transmit(i2c_device_, buffer, sizeof(buffer), kI2cTimeoutMs);
    if (ret == ESP_ERR_INVALID_STATE || ret == ESP_ERR_TIMEOUT) {
        ESP_LOGW(kTag, "write failed addr=0x%02x reg=0x%02x val=0x%02x err=%s", static_cast<unsigned>(device_address_),
                 static_cast<unsigned>(reg), static_cast<unsigned>(value), esp_err_to_name(ret));
        if (ResetBus("write_retry") == ESP_OK) {
            BoardI2cForcePowerOn();
            ret = i2c_master_transmit(i2c_device_, buffer, sizeof(buffer), kI2cTimeoutMs);
            ESP_LOGW(kTag, "write retry result addr=0x%02x reg=0x%02x val=0x%02x err=%s",
                     static_cast<unsigned>(device_address_), static_cast<unsigned>(reg), static_cast<unsigned>(value),
                     esp_err_to_name(ret));
        }
    }
    if (ret != ESP_OK) {
        ESP_LOGW(kTag, "write failed after_retry=1 addr=0x%02x reg=0x%02x err=%s",
                 static_cast<unsigned>(device_address_), static_cast<unsigned>(reg), esp_err_to_name(ret));
    }
    return ret;
}

esp_err_t I2cDevice::ReadReg(uint8_t reg, uint8_t* out) {
    if (!out)
        return ESP_ERR_INVALID_ARG;
    return ReadRegs(reg, out, 1);
}

esp_err_t I2cDevice::ReadRegs(uint8_t reg, uint8_t* buffer, size_t length) {
    if (!buffer || length == 0)
        return ESP_ERR_INVALID_ARG;
    ScopedI2cBusLock bus_lock("I2cDevice::ReadRegs");
    if (!bus_lock.locked()) {
        return bus_lock.status();
    }
    BoardI2cForcePowerOn();
    esp_err_t ret = i2c_master_transmit_receive(i2c_device_, &reg, 1, buffer, length, 100);
    if (ret == ESP_ERR_INVALID_STATE || ret == ESP_ERR_TIMEOUT) {
        ESP_LOGW(kTag, "read failed addr=0x%02x reg=0x%02x len=%u err=%s", static_cast<unsigned>(device_address_),
                 static_cast<unsigned>(reg), static_cast<unsigned>(length), esp_err_to_name(ret));
        if (ResetBus("read_retry") == ESP_OK) {
            BoardI2cForcePowerOn();
            ret = i2c_master_transmit_receive(i2c_device_, &reg, 1, buffer, length, 100);
            ESP_LOGW(kTag, "read retry result addr=0x%02x reg=0x%02x len=%u err=%s",
                     static_cast<unsigned>(device_address_), static_cast<unsigned>(reg), static_cast<unsigned>(length),
                     esp_err_to_name(ret));
        }
    }
    if (ret != ESP_OK) {
        ESP_LOGW(kTag, "read failed after_retry=1 addr=0x%02x reg=0x%02x len=%u err=%s",
                 static_cast<unsigned>(device_address_), static_cast<unsigned>(reg), static_cast<unsigned>(length),
                 esp_err_to_name(ret));
    }
    return ret;
}
