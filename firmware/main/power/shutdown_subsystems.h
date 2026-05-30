#pragma once

namespace system_shutdown {

using PreShutdownHook = void (*)();

void SetPreShutdownHook(PreShutdownHook hook);
bool WaitForEpdAndShutdown(int epd_timeout_ms);

}  // namespace system_shutdown
