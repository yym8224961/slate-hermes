#pragma once

#include <cstddef>
#include <cstdint>

#include "events/ui_event.h"
#include "startup/boot_mode.h"

namespace evt::log {

const char* ButtonName(ButtonId btn);
const char* KindName(UiEventKind kind);
const char* BootStageName(BootStage stage);
const char* GroupSyncStatusModeName(GroupSyncStatusMode mode);
const char* WakeCauseName(boot_mode::WakeCause cause);
const char* BootModeName(boot_mode::Mode mode);
bool        DebugEnabled(const char* tag);

// Writes a compact, single-line event payload summary into out.
void Describe(const UiEvent& e, char* out, size_t cap);

}  // namespace evt::log
