#pragma once

// Wi-Fi 单例：STA 与 SoftAP 模式互斥，内部按需创建/销毁 netif。
// 设计参考 xiaozhi-esp32 的 wifi-connect 组件:
//   - cfg.nvs_enable=false 禁用 ESP-IDF wifi 内置的 NVS 持久化,防止
//     mode/config 残留在 NVS 让重启后状态错乱
//   - StartAp/Connect 互斥:进任一边之前彻底停掉另一边
//   - Stop = 注销 event handler instance + esp_wifi_stop + destroy netif
//
// 重连策略:
//   1. 快速:STA_DISCONNECTED 立即 esp_wifi_connect,最多 5 次。
//   2. 慢速:5 次用完转 esp_timer + 主动 esp_wifi_scan_start 全信道扫描,
//      指数退避 10s → 20 → 40 → 80 → 120 → 120s。scan 找到 SSID 即拿
//      bssid+channel 设回 wc.sta 再 connect。
//   3. IP_GOT_IP 后清 fail_count_ + 重置 backoff_idx_,timer 停。
//   4. want_reconnect_=false (Disconnect / TryConnect 主动断 / StopAp) 时
//      整套机制不触发,纯静默。
//
// 用法:Wifi::Get().Init() 一次,之后 Connect/StartAp/...

#include <esp_event.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <lwip/inet.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

class Wifi {
   public:
    enum class State {
        Idle,          // 还没连过
        Connecting,    // 正在连接(快速 retry / 慢速 scan-then-connect 期间)
        Connected,     // 已连
        Disconnected,  // 已断开,慢速重连定时器在排队下一次尝试(若 want_reconnect_)
    };

    static Wifi& Get();

    // 一次性的最小底座:esp_netif_init + 默认 event loop + esp_wifi_init(nvs_enable=false)。
    // 不创建任何 netif,不调 wifi_start。NVS 由 App::InitStorage 统一初始化。
    void Init();

    // 进 STA 模式并连接。如果当前在 AP 模式,会先彻底停掉 AP。
    // 返回 false 时:Connect 同步等待超时(快速 retry 全失败),want_reconnect_
    // 已被置 false,慢速重连机制不会启动。调用方典型走 captive portal fallback。
    bool Connect(const std::string& ssid, const std::string& password, int timeout_ms = 15000);

    // 仅"试连":必须在 AP 模式下调用(captive portal /submit 用)。
    // 期间 wifi 处于 APSTA,STA 临时连接验证密码,验证完 disconnect 但 AP 保留。
    // 失败时 out_reason 填可读中文。本函数不开自动重连。
    bool TryConnect(const std::string& ssid, const std::string& password, int timeout_ms, std::string& out_reason);

    // 主动断开 STA(不下 wifi),后续不重连
    void Disconnect();

    bool  IsConnected() const;
    State state() const {
        return state_.load();
    }
    int8_t      GetRssi() const;
    std::string GetIp() const;

    // 启动 SoftAP(给 captive portal 用,SSID = prefix-{MAC后两位})。
    // 如果当前在 STA 模式,会先彻底停掉 STA。共存模式 APSTA 让 TryConnect
    // 能在配网期间复用同一个 wifi。
    bool StartAp(const std::string& ssid_prefix);

    // 彻底停 AP(esp_wifi_stop + destroy netif),不切回 STA。
    // 调用方(captive portal)Stop 后 App 会重启,启动时再走 Connect。
    void StopAp();

    // 注册事件回调
    using DisconnectCb = std::function<void(int reason_code)>;
    void OnDisconnected(DisconnectCb cb);

   private:
    enum class Mode {
        Off,
        Station,
        AccessPoint,
    };

    Wifi() = default;

    // 内部:进/出某个 mode。互斥状态机的核心。
    void StartStationInternal();
    void StartApInternal(const std::string& ssid_prefix);
    void StopStationInternal();
    void StopApInternal();

    void RegisterEventHandlers();
    void UnregisterEventHandlers();

    static void EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data);
    void        SetIpString(const char* ip);
    void        ClearIpString();

    // 慢速重连子系统:fast retry 用完 → 启 timer → DoSlowScan → SCAN_DONE → 找 AP → connect。
    // 找不到 → 递增 backoff_idx_ 再 ScheduleSlowReconnect 一次。
    void        EnsureReconnectTimer();
    void        ScheduleSlowReconnect();
    void        StopSlowReconnect();
    void        DoSlowScanReconnect();
    void        HandleSlowScanResult();
    static void OnSlowReconnectTimer(void* arg);

    // 仅 Init 调一次的底座
    std::mutex init_mutex_;
    bool       inited_ = false;

    // 当前模式。主线程修改，慢速重连 timer/event handler 读取。
    std::atomic<Mode> mode_{Mode::Off};

    // 按需创建/销毁
    esp_netif_t* sta_netif_ = nullptr;
    esp_netif_t* ap_netif_  = nullptr;

    // 用 instance 句柄注册,Stop 时精确注销;mode 切换前后必须保证已注销
    esp_event_handler_instance_t handler_wifi_ = nullptr;
    esp_event_handler_instance_t handler_ip_   = nullptr;

    // STA 状态
    std::atomic<State> state_{State::Idle};
    std::atomic<int>   fail_count_{0};
    int                max_fast_fail_ = 5;
    std::atomic<bool>  want_reconnect_{false};
    mutable std::mutex callback_mutex_;
    DisconnectCb       on_disconnect_;
    mutable std::mutex ip_mutex_;
    char               ip_str_[INET6_ADDRSTRLEN] = {0};
    std::atomic<int>   last_disconnect_reason_{0};

    // 慢速重连
    esp_timer_handle_t  reconnect_timer_ = nullptr;
    std::atomic<size_t> backoff_idx_{0};
    std::atomic<bool>   slow_scan_pending_{false};  // 区分本次 SCAN_DONE 是不是我们发起的
};
