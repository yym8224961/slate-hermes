#pragma once

namespace system_restart {

[[noreturn]] void GracefulRestart(int pre_delay_ms = 0, int epd_timeout_ms = 8000);

}  // namespace system_restart
