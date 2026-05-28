#include "config.h"
#include "gpio_util.h"

extern "C" void BoardI2cForcePowerOn() {
    GpioWriteHold(AUDIO_PWR_PIN, AUDIO_PWR_FORCE_LEVEL);
}
