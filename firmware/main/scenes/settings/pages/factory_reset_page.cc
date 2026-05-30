#include "scenes/settings/pages/factory_reset_page.h"

#include <esp_log.h>

#include "storage/cache/cache.h"
#include "network/cred_store.h"
#include "storage/nvs/nvs_schema.h"
#include "storage/nvs/nvs_store.h"
#include "power/system_restart.h"
#include "xiaozhi/config/settings.h"

namespace {
constexpr char kTag[] = "FactoryReset";
}

FactoryResetPage::FactoryResetPage()
    : ConfirmActionPage("FactoryReset", "恢复出厂",
                        "确认要恢复出厂吗？\n\n"
                        "Wi-Fi 配置、设备绑定\n"
                        "小智配置及内容缓存\n"
                        "将全部清除\n"
                        "重启后进入配网模式") {
}

FactoryResetPage::~FactoryResetPage() = default;

void FactoryResetPage::Confirm(SceneContext&) {
    ESP_LOGW(kTag, "Long Enter -> factory reset: clear NVS + format littlefs + reboot");
    cred::Clear();
    nvs_store::EraseNamespace(nvs_schema::kAudio);
    xiaozhi::settings::ClearAll();
    cache::FormatAll();
    system_restart::GracefulRestart(200);
}
