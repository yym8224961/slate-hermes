#pragma once

#include <cstdint>
#include <string>

#include "cred_store.h"

namespace boot_mode {

enum class WakeCause : uint8_t {
    kColdBoot = 0,
    kButton,
    kCharge,
    kRtcTimer,
    kOther,
};

enum class Mode : uint8_t {
    kPortal,
    kBackgroundRefresh,
    kFullActive,
};

struct Decision {
    Mode        mode       = Mode::kFullActive;
    WakeCause   wake_cause = WakeCause::kColdBoot;
    std::string wake_reason;
    uint64_t    ext1_mask      = 0;
    bool        first_register = false;
};

Decision Decide(const cred::Credentials& creds);

}  // namespace boot_mode
