#pragma once

#include <driver/gpio.h>

// 把"hold_dis → set_level → hold_en"三段式打包成一个 inline。
// 板上很多 rail 用 hold_en 锁电平避免 deep/light sleep 期间被 IO MUX 拉低,
// 改电平时必须先 hold_dis,否则 set_level 不生效;再 hold_en 重新锁回去。
//
// 没有用 RAII 是因为大多数调用点只需要原子地"改一次锁回去",并不持有 hold 状态。
inline void GpioWriteHold(gpio_num_t pin, int level) {
    gpio_hold_dis(pin);
    gpio_set_level(pin, level);
    gpio_hold_en(pin);
}

inline void GpioWriteHold(int pin, int level) {
    GpioWriteHold(static_cast<gpio_num_t>(pin), level);
}
