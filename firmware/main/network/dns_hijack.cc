#include "dns_hijack.h"

#include <esp_log.h>
#include <lwip/netdb.h>
#include <lwip/sockets.h>

#include <cerrno>
#include <cstring>

namespace {
constexpr char kTag[] = "DnsHijack";
constexpr int  kDnsQueryMaxBytes = 512;
constexpr int  kDnsAnswerBytes   = 16;
}

DnsHijack::~DnsHijack() {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    StopLocked(portMAX_DELAY);
    if (!task_handle_ && exit_sem_) {
        vSemaphoreDelete(exit_sem_);
        exit_sem_ = nullptr;
    }
}

void DnsHijack::Start(esp_ip4_addr_t gateway, uint16_t port) {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    if (task_handle_ && !StopLocked(pdMS_TO_TICKS(2000))) {
        ESP_LOGW(kTag, "Previous DNS task still stopping; start skipped");
        return;
    }

    gateway_ = gateway;
    port_    = port;

    if (!exit_sem_) {
        exit_sem_ = xSemaphoreCreateBinary();
        configASSERT(exit_sem_);
    }
    while (xSemaphoreTake(exit_sem_, 0) == pdTRUE) {
    }

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(kTag, "Socket failed: %d", errno);
        return;
    }

    sockaddr_in addr     = {};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port        = htons(port_);

    if (bind(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ESP_LOGE(kTag, "Bind :%u failed: %d", port_, errno);
        close(sock);
        return;
    }

    fd_.store(sock);
    running_.store(true);
    BaseType_t ok = xTaskCreate(
        [](void* arg) {
            auto* self = static_cast<DnsHijack*>(arg);
            self->Run();
            xSemaphoreGive(self->exit_sem_);
            vTaskDelete(nullptr);
        },
        "dns_hijack", 4 * 1024, this, 5, &task_handle_);
    if (ok != pdPASS) {
        ESP_LOGE(kTag, "Task create failed");
        running_.store(false);
        fd_.store(-1);
        close(sock);
        task_handle_ = nullptr;
    }
}

void DnsHijack::Stop() {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    StopLocked(pdMS_TO_TICKS(2000));
}

bool DnsHijack::StopLocked(TickType_t wait_ticks) {
    const bool had_task = task_handle_ != nullptr;
    if (!running_.exchange(false) && !had_task)
        return true;
    int sock = fd_.exchange(-1);
    if (sock >= 0) {
        shutdown(sock, SHUT_RDWR);
        close(sock);  // recvfrom 返 -1 后 Run 看 running_=false 即退出
    }
    if (exit_sem_ && had_task) {
        // 等 task 真正退出再返回。2s 兜底:即便 lwip 出意外阻塞,Stop 也不会永挂。
        if (xSemaphoreTake(exit_sem_, wait_ticks) != pdTRUE) {
            ESP_LOGW(kTag, "DNS task did not exit before stop timeout");
            return false;
        }
    }
    task_handle_ = nullptr;
    return true;
}

void DnsHijack::Run() {
    char buf[kDnsQueryMaxBytes + kDnsAnswerBytes];
    while (running_.load()) {
        const int sock = fd_.load();
        if (sock < 0)
            break;
        sockaddr_in client     = {};
        socklen_t   client_len = sizeof(client);
        int         len =
            recvfrom(sock, buf, kDnsQueryMaxBytes, 0, reinterpret_cast<sockaddr*>(&client), &client_len);
        if (len < 0) {
            if (!running_.load())
                break;
            ESP_LOGE(kTag, "Recvfrom failed: %d", errno);
            continue;
        }
        if (!running_.load())
            break;
        if (len < 12)
            continue;  // DNS header ≥ 12 字节

        // 标准 DNS 响应:把请求 header 改成 response,answer count=1,
        // 在尾部加一条 A record 指向 gateway。
        buf[2] |= 0x80;  // QR=1 (response)
        buf[3] = 0x80;   // RA=1, clear any query RCODE bits
        buf[7] = 1;      // ANCOUNT=1

        // Answer:NAME pointer to query name (offset 0x0c) + TYPE A + CLASS IN +
        // TTL 28s + RDLENGTH=4 + RDATA(gateway IP)
        if (len + kDnsAnswerBytes > (int)sizeof(buf))
            continue;
        std::memcpy(&buf[len], "\xc0\x0c", 2);
        len += 2;
        std::memcpy(&buf[len], "\x00\x01\x00\x01\x00\x00\x00\x1c\x00\x04", 10);
        len += 10;
        std::memcpy(&buf[len], &gateway_.addr, 4);
        len += 4;

        const int send_sock = fd_.load();
        if (send_sock < 0)
            break;
        sendto(send_sock, buf, len, 0, reinterpret_cast<sockaddr*>(&client), client_len);
    }
}
