#pragma once

namespace system_restart {

[[noreturn]] void GracefulRestart(int pre_delay_ms = 0, int epd_wait_ms = 8000);

}  // namespace system_restart
