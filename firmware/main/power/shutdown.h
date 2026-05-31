#pragma once

namespace power_shutdown {

using PreShutdownHook = void (*)();

void SetPreShutdownHook(PreShutdownHook hook);
bool WaitForEpdAndShutdown(int epd_timeout_ms);

[[noreturn]] void GracefulRestart(int pre_delay_ms = 0, int epd_timeout_ms = 8000);

}  // namespace power_shutdown
