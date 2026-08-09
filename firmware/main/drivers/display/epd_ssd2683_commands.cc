#include "drivers/display/epd_ssd2683.h"

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "drivers/display/framebuffer_ops.h"
#include "utils/time_utils.h"

esp_err_t EpdSsd2683::EpdInit() {
    if (!spi_) {
        const esp_err_t spi_err = SpiPortInit();
        if (spi_err != ESP_OK)
            return spi_err;
    }
    EpdPowerOn();
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(rst_, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(rst_, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(rst_, 1);
    vTaskDelay(pdMS_TO_TICKS(10));

    esp_err_t err = ReadBusy("reset");
    if (err == ESP_OK)
        err = EpdSendCommand(0x00);
    if (err == ESP_OK)
        err = EpdSendData(0x2F);
    if (err == ESP_OK)
        err = EpdSendData(0x0E);  // SSD2683 OTP waveform selection
    if (err == ESP_OK)
        err = EpdSendCommand(0xE9);
    if (err == ESP_OK)
        err = EpdSendData(0x01);
    if (err == ESP_OK)
        err = ReadBusy("OTP init");
    return err;
}

esp_err_t EpdSsd2683::ApplyTemperatureBoost() {
    // 0x40 = Get Temp。读屏温后按官方 NOTE4 驱动映射 5 档 booster；60 秒内
    // 复用结果，避免每轮全刷都重建 SPI RX/TX bus。
    constexpr int64_t kCacheValidMs = 60 * 1000;
    const int64_t     now_ms        = time_utils::NowMs();

    uint8_t booster = cached_booster_;
    if (booster == 0 || (now_ms - last_temp_read_ms_) >= kCacheValidMs) {
        esp_err_t err = EpdSendCommand(0x40);
        if (err == ESP_OK)
            err = ReadBusy("temperature read");
        uint8_t temp = 25;
        if (err == ESP_OK)
            err = EpdRecvData(&temp);
        if (err != ESP_OK)
            return err;

        if (temp <= 5)
            booster = 232;
        else if (temp <= 10)
            booster = 235;
        else if (temp <= 20)
            booster = 238;
        else if (temp <= 30)
            booster = 241;
        else if (temp <= 127)
            booster = 244;
        else
            booster = 232;
        cached_booster_    = booster;
        last_temp_read_ms_ = now_ms;
    }

    esp_err_t err = EpdSendCommand(0xE0);
    if (err == ESP_OK)
        err = EpdSendData(0x02);
    if (err == ESP_OK)
        err = EpdSendCommand(0xE6);
    if (err == ESP_OK)
        err = EpdSendData(booster);
    if (err == ESP_OK)
        err = EpdSendCommand(0xA5);
    if (err == ESP_OK)
        err = ReadBusy("temperature activate");
    if (err == ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(10));
    return err;
}

esp_err_t EpdSsd2683::EpdDisplayFull() {
    const int bpr     = (kWidth + 7) >> 3;
    const int bpr_out = bpr * 2;
    uint8_t*  line    = epd_line_.data();

    esp_err_t err = ApplyTemperatureBoost();
    if (err == ESP_OK)
        err = EpdSendCommand(0x10);
    for (int y = 0; err == ESP_OK && y < kHeight; ++y) {
        const uint8_t* src = snapshot_ + y * bpr;
        for (int xb = 0; xb < bpr; ++xb)
            epd::Pack1bppTo2683(src[xb], line[2 * xb], line[2 * xb + 1]);
        err = WriteBytes(line, bpr_out);
    }
    if (err == ESP_OK)
        err = EpdTurnOnDisplay();
    return err;
}

esp_err_t EpdSsd2683::SetPartialWindow(const epd::Rect& bounds) {
    const epd::Rect rect = epd::Clamp(epd::AlignX8(bounds), kWidth, kHeight);
    if (epd::Area(rect) == 0)
        return ESP_ERR_INVALID_ARG;

    const int x1 = rect.x + rect.w - 1;
    const int y1 = rect.y + rect.h - 1;
    const uint8_t values[] = {
        static_cast<uint8_t>((rect.x >> 8) & 0x03), static_cast<uint8_t>(rect.x),
        static_cast<uint8_t>((x1 >> 8) & 0x03), static_cast<uint8_t>(x1),
        static_cast<uint8_t>((rect.y >> 8) & 0x03), static_cast<uint8_t>(rect.y),
        static_cast<uint8_t>((y1 >> 8) & 0x03), static_cast<uint8_t>(y1), 0x01,
    };

    esp_err_t err = EpdSendCommand(0x83);
    for (uint8_t value : values) {
        if (err != ESP_OK)
            break;
        err = EpdSendData(value);
    }
    return err;
}

esp_err_t EpdSsd2683::EpdDisplayPartial(const epd::Rect& bounds) {
    const epd::Rect rect = epd::Clamp(epd::AlignX8(bounds), kWidth, kHeight);
    if (epd::Area(rect) == 0)
        return ESP_ERR_INVALID_ARG;

    const int bpr           = (kWidth + 7) >> 3;
    const int first_byte_x  = rect.x >> 3;
    const int source_bytes  = rect.w >> 3;
    const int output_bytes  = source_bytes * 2;
    uint8_t*  line          = epd_line_.data();

    // NOTE4 官方 SSD2683 局刷序列：transition mode + window，随后仅发送
    // dirty rectangle 的旧/新像素对，而不是每次传完整 30 KB 帧。
    esp_err_t err = EpdSendCommand(0x50);
    if (err == ESP_OK)
        err = EpdSendData(0x77);
    if (err == ESP_OK)
        err = EpdSendCommand(0xE0);
    if (err == ESP_OK)
        err = EpdSendData(0x00);
    if (err == ESP_OK)
        err = EpdSendCommand(0xA5);
    if (err == ESP_OK)
        err = ReadBusy("partial temperature");
    if (err == ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(10));
    if (err == ESP_OK)
        err = SetPartialWindow(rect);
    if (err == ESP_OK)
        err = EpdSendCommand(0x10);
    if (err == ESP_OK)
        err = ReadBusy("partial RAM write");

    for (int y = rect.y; err == ESP_OK && y < rect.y + rect.h; ++y) {
        const uint8_t* prev = prev_snapshot_ + y * bpr + first_byte_x;
        const uint8_t* now  = snapshot_ + y * bpr + first_byte_x;
        for (int xb = 0; xb < source_bytes; ++xb)
            epd::PackPartial1bppTo2683(prev[xb], now[xb], line[2 * xb], line[2 * xb + 1]);
        err = WriteBytes(line, output_bytes);
    }
    if (err == ESP_OK)
        err = EpdTurnOnDisplay();
    return err;
}

esp_err_t EpdSsd2683::EpdTurnOnDisplay() {
    esp_err_t err = EpdSendCommand(0x04);
    if (err == ESP_OK)
        err = ReadBusy("internal power on");
    if (err == ESP_OK)
        err = EpdSendCommand(0x12);
    if (err == ESP_OK)
        err = EpdSendData(0x00);
    if (err == ESP_OK)
        err = ReadBusy("display refresh");

    // BUSY 超时时 controller 状态未知，不再继续发 0x02；直接切外部 rail。
    if (err == ESP_OK)
        err = EpdSendCommand(0x02);
    if (err == ESP_OK)
        err = EpdSendData(0x00);
    if (err == ESP_OK)
        err = ReadBusy("internal power off");
    EpdPowerOff();
    return err;
}
