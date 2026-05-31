#pragma once

#include <esp_timer.h>

#include <atomic>
#include <cstddef>

class Wifi;

class WifiReconnectManager {
   public:
    explicit WifiReconnectManager(Wifi* owner);
    ~WifiReconnectManager();

    void ResetBackoff();
    void Schedule();
    void Stop();
    bool ConsumeSlowScanPending();
    void DoSlowScanReconnect();
    void HandleSlowScanResult();

   private:
    void        EnsureTimer();
    static void OnTimer(void* arg);

    Wifi*               owner_ = nullptr;
    esp_timer_handle_t  timer_ = nullptr;
    std::atomic<size_t> backoff_idx_{0};
    std::atomic<bool>   slow_scan_pending_{false};
};
