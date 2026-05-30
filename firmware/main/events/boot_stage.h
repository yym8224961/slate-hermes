#pragma once

#include <cstdint>

// boot 阶段枚举;splash 用此切文案。顺序对应 splash 状态机典型路径。
enum class BootStage : uint8_t {
    kInitializing = 0,
    kProvisioning,       // 无 cred,captive portal 模式
    kWifiConnecting,     // 试连 STA(载荷带 ssid)
    kWifiFailed,         // 试连超时/认证失败
    kSntp,               // 等系统时间对齐
    kRegistering,        // 调 /devices
    kServerUnreachable,  // 服务器 30s 无响应
    kAwaitingPair,       // 注册完毕,等待 Web 端 claim(载荷带 pair_code)
    kAwaitingGroup,      // 已 bound,等待管理端分配内容组
    kNetError,           // 其它网络异常
};
