#pragma once

// NVS namespace "slate" 凭据存储:wifi_ssid / wifi_pwd / server_url / device_name。
// 设备协议无独立 token,server 按 mac 识别,所以这里也不存 token。

#include <string>

namespace cred {

struct Credentials {
    std::string wifi_ssid;
    std::string wifi_pwd;
    std::string server_url;
    std::string device_name;
};

bool        Load(Credentials& out);          // false 表示从未配过 wifi
bool        Save(const Credentials& c);
std::string GetServerUrl();                   // 便利:从 NVS 读 server_url
void        Clear();                          // 长按重置:清整个 namespace

}  // namespace cred
