#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <cstdint>

namespace cache::internal {

SemaphoreHandle_t StateMutex();

void ResetStateCache();
bool NextCacheAccessSeq(uint32_t& out);

}  // namespace cache::internal
