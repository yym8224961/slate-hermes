#include "drivers/display/epd_ssd2683.h"

#include <driver/gpio.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "bsp/config.h"
#include "utils/gpio_util.h"
#include "utils/time_utils.h"

namespace {
constexpr char kTag[]              = "epd";
constexpr int  kWriteClockHz       = 20 * 1000 * 1000;
constexpr int  kReadClockHz        = 8 * 1000 * 1000;
constexpr int  kMaxTransferBytes   = 1024;
constexpr int  kBusyTimeoutMs      = 5000;
}  // namespace

// SSD2683 的 SDA 是单线双向数据脚。读取温度时需要把同一物理脚从 MOSI
// 切换成 MISO，因此切换期间重建 SPI bus；只有 refresh task 可以执行。
void EpdSsd2683::AssertRefreshTaskContext() const {
    configASSERT(refresh_task_ == nullptr || xTaskGetCurrentTaskHandle() == refresh_task_);
}

esp_err_t EpdSsd2683::SpiPortInit() {
    AssertRefreshTaskContext();
    if (spi_) {
        const esp_err_t remove_err = spi_bus_remove_device(spi_);
        if (remove_err != ESP_OK)
            return remove_err;
        spi_ = nullptr;
    }
    if (spi_inited_) {
        const esp_err_t free_err = spi_bus_free(spi_host_);
        if (free_err != ESP_OK && free_err != ESP_ERR_INVALID_STATE)
            return free_err;
        spi_inited_ = false;
    }

    spi_bus_config_t bus = {};
    bus.miso_io_num      = -1;
    bus.mosi_io_num      = mosi_;
    bus.sclk_io_num      = sclk_;
    bus.quadwp_io_num    = -1;
    bus.quadhd_io_num    = -1;
    bus.max_transfer_sz  = kMaxTransferBytes;
    esp_err_t err        = spi_bus_initialize(spi_host_, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK)
        return err;
    spi_inited_ = true;

    spi_device_interface_config_t dev = {};
    dev.spics_io_num                   = -1;
    dev.clock_speed_hz                 = kWriteClockHz;
    dev.mode                           = 0;
    dev.queue_size                     = 1;
    err                                = spi_bus_add_device(spi_host_, &dev, &spi_);
    if (err != ESP_OK) {
        spi_bus_free(spi_host_);
        spi_inited_ = false;
    }
    return err;
}

esp_err_t EpdSsd2683::SpiPortRxInit() {
    AssertRefreshTaskContext();
    if (spi_) {
        const esp_err_t remove_err = spi_bus_remove_device(spi_);
        if (remove_err != ESP_OK)
            return remove_err;
        spi_ = nullptr;
    }
    if (spi_inited_) {
        const esp_err_t free_err = spi_bus_free(spi_host_);
        if (free_err != ESP_OK && free_err != ESP_ERR_INVALID_STATE)
            return free_err;
        spi_inited_ = false;
    }

    spi_bus_config_t bus = {};
    bus.miso_io_num      = mosi_;
    bus.mosi_io_num      = -1;
    bus.sclk_io_num      = sclk_;
    bus.quadwp_io_num    = -1;
    bus.quadhd_io_num    = -1;
    bus.max_transfer_sz  = kMaxTransferBytes;
    esp_err_t err        = spi_bus_initialize(spi_host_, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK)
        return err;
    spi_inited_ = true;

    spi_device_interface_config_t dev = {};
    dev.spics_io_num                   = -1;
    dev.clock_speed_hz                 = kReadClockHz;
    dev.mode                           = 0;
    dev.queue_size                     = 1;
    err                                = spi_bus_add_device(spi_host_, &dev, &spi_);
    if (err != ESP_OK) {
        spi_bus_free(spi_host_);
        spi_inited_ = false;
    }
    return err;
}

esp_err_t EpdSsd2683::EpdRecvData(uint8_t* out) {
    if (!out)
        return ESP_ERR_INVALID_ARG;
    AssertRefreshTaskContext();
    esp_err_t err = SpiPortRxInit();
    if (err != ESP_OK) {
        SpiPortInit();
        return err;
    }

    spi_transaction_t t = {};
    t.length            = 8;
    t.flags             = SPI_TRANS_USE_RXDATA;
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    err = spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
    if (err == ESP_OK)
        *out = t.rx_data[0];

    const esp_err_t restore_err = SpiPortInit();
    return err != ESP_OK ? err : restore_err;
}

esp_err_t EpdSsd2683::SpiGpioInit() {
    gpio_config_t power = {};
    power.intr_type     = GPIO_INTR_DISABLE;
    power.mode          = GPIO_MODE_OUTPUT;
    power.pin_bit_mask  = 1ULL << EPD_PWR_PIN;
    power.pull_up_en    = GPIO_PULLUP_DISABLE;
    power.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    esp_err_t err       = gpio_config(&power);

    gpio_config_t output = {};
    output.intr_type     = GPIO_INTR_DISABLE;
    output.mode          = GPIO_MODE_OUTPUT;
    output.pin_bit_mask  = (1ULL << cs_) | (1ULL << dc_) | (1ULL << rst_);
    output.pull_up_en    = GPIO_PULLUP_ENABLE;
    output.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    if (err == ESP_OK)
        err = gpio_config(&output);

    gpio_config_t input = {};
    input.intr_type     = GPIO_INTR_DISABLE;
    input.mode          = GPIO_MODE_INPUT;
    input.pin_bit_mask  = 1ULL << busy_;
    input.pull_up_en    = GPIO_PULLUP_ENABLE;
    input.pull_down_en  = GPIO_PULLDOWN_DISABLE;
    if (err == ESP_OK)
        err = gpio_config(&input);
    if (err == ESP_OK)
        err = gpio_set_level(rst_, 1);
    if (err == ESP_OK)
        err = gpio_set_level(cs_, 1);
    return err;
}

esp_err_t EpdSsd2683::ReadBusy(const char* operation) {
    const int64_t start_ms = time_utils::NowMs();
    while (gpio_get_level(busy_) == 0) {
        if (time_utils::NowMs() - start_ms >= kBusyTimeoutMs) {
            ESP_LOGE(kTag, "busy timeout operation=%s elapsed_ms=%d", operation, kBusyTimeoutMs);
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return ESP_OK;
}

esp_err_t EpdSsd2683::EpdSendCommand(uint8_t command) {
    if (!spi_)
        return ESP_ERR_INVALID_STATE;
    spi_transaction_t t = {};
    t.length            = 8;
    t.flags             = SPI_TRANS_USE_TXDATA;
    t.tx_data[0]        = command;
    gpio_set_level(dc_, 0);
    gpio_set_level(cs_, 0);
    const esp_err_t err = spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
    return err;
}

esp_err_t EpdSsd2683::EpdSendData(uint8_t data) {
    if (!spi_)
        return ESP_ERR_INVALID_STATE;
    spi_transaction_t t = {};
    t.length            = 8;
    t.flags             = SPI_TRANS_USE_TXDATA;
    t.tx_data[0]        = data;
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    const esp_err_t err = spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
    return err;
}

esp_err_t EpdSsd2683::WriteBytes(const uint8_t* data, int len) {
    if (!spi_ || !data || len <= 0 || len > kMaxTransferBytes)
        return ESP_ERR_INVALID_ARG;
    spi_transaction_t t = {};
    t.length            = 8 * len;
    t.tx_buffer         = data;
    gpio_set_level(dc_, 1);
    gpio_set_level(cs_, 0);
    const esp_err_t err = spi_device_polling_transmit(spi_, &t);
    gpio_set_level(cs_, 1);
    return err;
}

void EpdSsd2683::EpdPowerOn() {
    GpioWriteHold(EPD_PWR_PIN, 1);
}

void EpdSsd2683::EpdPowerOff() {
    GpioWriteHold(EPD_PWR_PIN, 0);
}
