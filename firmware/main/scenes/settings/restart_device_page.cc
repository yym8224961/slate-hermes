#include "restart_device_page.h"

#include <esp_log.h>

#include "system_restart.h"

namespace {
constexpr char kTag[] = "Restart";
}

RestartDevicePage::RestartDevicePage()
    : ConfirmActionPage("RestartDevice", "重启设备",
                        "确认要重启设备吗？\n\n"
                        "Wi-Fi 配置和已下载\n"
                        "的内容缓存都保留\n"
                        "重启完成后自动恢复",
                        [](SceneContext&) {
                            ESP_LOGW(kTag, "Long Enter -> restart device");
                            system_restart::GracefulRestart(200);
                        }) {
}

RestartDevicePage::~RestartDevicePage() = default;
