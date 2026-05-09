#pragma once

// WiFi STA 管理:从 NVS 读凭据,连接,断线重连(指数退避)。
// 单例风格:Init() 一次,之后 Connect/Disconnect/Get*。

#include <esp_event.h>
#include <esp_netif.h>
#include <esp_wifi.h>

#include <atomic>
#include <functional>
#include <string>

class Wifi {
   public:
    enum class State {
        Idle,         // 还没连过
        Connecting,   // 正在连接
        Connected,    // 已连
        Disconnected, // 主动断开或刚启动
        Failed,       // 连续失败超阈值
    };

    static Wifi& Get();

    void Init();  // 创建 netif/event_loop/wifi driver,只调一次

    bool       Connect(const std::string& ssid, const std::string& password,
                       int timeout_ms = 15000);
    // 仅"试连":在 APSTA 下尝试 STA 连接,成功后立即 disconnect,
    // state 不切 Connected,fail_count 不变。captive portal /submit 用。
    // 失败时 out_reason 填可读中文(密码错/SSID 找不到/超时等)。
    bool       TryConnect(const std::string& ssid, const std::string& password,
                          int timeout_ms, std::string& out_reason);
    void       Disconnect();
    bool       IsConnected() const;
    State      state() const { return state_.load(); }
    int8_t     GetRssi() const;  // 未连接时返回 0
    std::string GetIp() const;    // dotted, 空字符串若未拿到

    // 启动 SoftAP(给 captive portal 用,SSID = prefix-{MAC后两位})
    bool       StartAp(const std::string& ssid_prefix);
    void       StopAp();

    // 注册事件回调
    using DisconnectCb = std::function<void(int reason_code)>;
    void OnDisconnected(DisconnectCb cb);

   private:
    Wifi() = default;

    static void EventHandler(void* arg, esp_event_base_t base, int32_t id, void* data);

    std::atomic<State> state_{State::Idle};
    int                fail_count_       = 0;
    int                max_fail_         = 5;  // 5 次失败 → Failed
    bool               want_reconnect_   = false;
    DisconnectCb       on_disconnect_;
    esp_netif_t*       sta_netif_        = nullptr;
    esp_netif_t*       ap_netif_         = nullptr;
    bool               inited_           = false;
    bool               sta_active_       = false;
    bool               ap_active_        = false;
    char               ip_str_[16]       = {0};
    int                last_disconnect_reason_ = 0;  // wifi_err_reason_t
};
