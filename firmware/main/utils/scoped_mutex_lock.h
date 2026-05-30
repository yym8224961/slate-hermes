#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

class ScopedMutexLock {
   public:
    explicit ScopedMutexLock(SemaphoreHandle_t mutex) : mutex_(mutex) {
        configASSERT(mutex_);
        const bool ok = xSemaphoreTake(mutex_, portMAX_DELAY) == pdTRUE;
        configASSERT(ok);
    }

    ~ScopedMutexLock() {
        if (mutex_)
            xSemaphoreGive(mutex_);
    }

    ScopedMutexLock(const ScopedMutexLock&)            = delete;
    ScopedMutexLock& operator=(const ScopedMutexLock&) = delete;

    bool locked() const {
        return mutex_ != nullptr;
    }

   private:
    SemaphoreHandle_t mutex_ = nullptr;
};

class TryScopedMutexLock {
   public:
    explicit TryScopedMutexLock(SemaphoreHandle_t mutex, TickType_t timeout_ticks)
        : mutex_(mutex), locked_(mutex && xSemaphoreTake(mutex, timeout_ticks) == pdTRUE) {
    }

    ~TryScopedMutexLock() {
        if (locked_)
            xSemaphoreGive(mutex_);
    }

    TryScopedMutexLock(const TryScopedMutexLock&)            = delete;
    TryScopedMutexLock& operator=(const TryScopedMutexLock&) = delete;

    bool locked() const {
        return locked_;
    }

   private:
    SemaphoreHandle_t mutex_  = nullptr;
    bool              locked_ = false;
};
