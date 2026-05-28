#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

class ScopedMutexLock {
   public:
    explicit ScopedMutexLock(SemaphoreHandle_t mutex, TickType_t timeout_ticks = portMAX_DELAY)
        : mutex_(mutex), locked_(mutex && xSemaphoreTake(mutex, timeout_ticks) == pdTRUE) {
    }

    ~ScopedMutexLock() {
        if (locked_)
            xSemaphoreGive(mutex_);
    }

    ScopedMutexLock(const ScopedMutexLock&)            = delete;
    ScopedMutexLock& operator=(const ScopedMutexLock&) = delete;

    bool locked() const {
        return locked_;
    }

   private:
    SemaphoreHandle_t mutex_  = nullptr;
    bool              locked_ = false;
};
