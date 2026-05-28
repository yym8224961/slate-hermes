#pragma once

#include <driver/i2c_master.h>
#include <esp_err.h>

class I2cDevice {
   public:
    I2cDevice(i2c_master_bus_handle_t i2c_bus, uint8_t addr);

   protected:
    esp_err_t               ResetBus(const char* reason);
    esp_err_t               AddDeviceLocked();
    esp_err_t               RecreateDeviceLocked();
    i2c_master_dev_handle_t i2c_device_;
    i2c_master_bus_handle_t i2c_bus_;
    uint8_t                 device_address_ = 0;

    esp_err_t WriteReg(uint8_t reg, uint8_t value);
    esp_err_t ReadReg(uint8_t reg, uint8_t* out);
    esp_err_t ReadRegs(uint8_t reg, uint8_t* buffer, size_t length);
};
