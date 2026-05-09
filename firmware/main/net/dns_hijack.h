#pragma once

// SoftAP 配网期间的 DNS 劫持:监听 UDP 53,把所有 DNS 查询伪造响应指向
// 192.168.4.1(AP gateway),配合 DHCP 推 DNS = AP IP,实现 OS 自动弹出
// captive portal 配网页(手机/笔记本连上 AP 后探测 connectivitycheck.* 等
// → 解析到本机 → HTTP 200/302 → OS 弹页)。
//
// 实现照搬 esp32-eink/managed_components/78__esp-wifi-connect/dns_server.cc 思路,
// 改成本项目命名空间。

#include <esp_netif.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <atomic>

class DnsHijack {
   public:
    DnsHijack() = default;
    ~DnsHijack();

    void Start(esp_ip4_addr_t gateway, uint16_t port = 53);
    void Stop();  // 阻塞直到 task 真正退出,保证 ~DnsHijack 之后无悬挂回调

   private:
    void Run();

    esp_ip4_addr_t       gateway_     = {};
    std::atomic<int>     fd_{-1};
    std::atomic<bool>    running_{false};
    TaskHandle_t         task_handle_ = nullptr;
    SemaphoreHandle_t    exit_sem_    = nullptr;  // task 退出时 give,Stop 等它
    uint16_t             port_        = 53;
};
