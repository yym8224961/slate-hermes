#include "device_info_page.h"

#include <cstdio>
#include <esp_heap_caps.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <sdkconfig.h>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../net/cred_store.h"
#include "../net/wifi.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "dev_info";

const char* ChargeText(const ChargeStatus::Snapshot& s) {
    if (s.no_battery) return "无电池";
    if (s.full)        return "已充满";
    if (s.charging)    return "充电中";
    if (s.power_present) return "已接电源";
    return "电池供电";
}
}  // namespace

DeviceInfoPage::DeviceInfoPage()  = default;
DeviceInfoPage::~DeviceInfoPage() = default;

void DeviceInfoPage::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) return;

    auto* screen = lv_screen_active();
    root_ = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("设备信息");

    // 可滚动内容区:状态栏下方占满。UP/DOWN 按键 scroll 上下翻。
    // pad_bottom 16 让滚到底时最后一行不紧贴底边(LVGL 把 padding 算进 scroll_bottom)。
    scroll_area_ = lv_obj_create(root_);
    lv_obj_set_size(scroll_area_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(scroll_area_, 0, theme::kStatusBarHeight);
    lv_obj_set_style_bg_color(scroll_area_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(scroll_area_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scroll_area_, 0, 0);
    lv_obj_set_style_pad_bottom(scroll_area_, 16, 0);
    lv_obj_set_style_border_width(scroll_area_, 0, 0);
    lv_obj_add_flag(scroll_area_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(scroll_area_, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(scroll_area_, LV_SCROLLBAR_MODE_OFF);

    info_ = lv_label_create(scroll_area_);
    lv_obj_set_style_text_font(info_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(info_, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(info_, 4, 0);
    lv_obj_set_style_text_align(info_, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_width(info_, LV_HOR_RES - 48);
    lv_label_set_long_mode(info_, LV_LABEL_LONG_WRAP);
    lv_obj_set_pos(info_, 24, 12);  // 相对 scroll_area_,顶部留 12px

    Refresh(ctx);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void DeviceInfoPage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void DeviceInfoPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            // 一屏装不下,UP/DOWN 翻看;ENTER 短按返回。
            // UP = 视野上移(看上方内容)、DOWN = 视野下移(看下方内容)。
            constexpr int kScrollStep = 80;  // 一次约 4 行(20px/行)
            switch (e.u.button.btn) {
                case ButtonId::kUp:    ScrollBy(ctx, -kScrollStep); break;
                case ButtonId::kDown:  ScrollBy(ctx, +kScrollStep); break;
                case ButtonId::kEnter: ctx.stack->RequestPop();      break;
            }
            break;
        }
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) ctx.stack->RequestPop();
            break;
        case UiEventKind::kChargeChanged:
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kWifiStateChanged:
        case UiEventKind::kMinuteTick:
            // 信息发生变化时刷新本页内容。
            Refresh(ctx);
            SyncRender(ctx);
            break;
        default:
            break;
    }
}

void DeviceInfoPage::ScrollBy(SceneContext& ctx, int dy_view) {
    if (!scroll_area_) return;
    // dy_view 正值 = 视野往下看(看到下方内容);负值 = 视野上移看上方。
    // 用 scroll_to_y 显式 clamp,到顶/底再按方向键就完全无效(不再触发 EPD 刷新)。
    const int cur_y = lv_obj_get_scroll_y(scroll_area_);
    const int max_y = cur_y + lv_obj_get_scroll_bottom(scroll_area_);
    int new_y = cur_y + dy_view;
    if (new_y < 0)     new_y = 0;
    if (new_y > max_y) new_y = max_y;
    if (new_y == cur_y) return;  // 已到边界,什么都不做
    lv_obj_scroll_to_y(scroll_area_, new_y, LV_ANIM_OFF);
    SyncRender(ctx);
}

void DeviceInfoPage::Refresh(SceneContext& ctx) {
    if (!info_) return;

    // 同时更新状态栏(让 wifi/电量图标也跟随当前实际状态)
    if (status_bar_) {
        if (ctx.wifi_connected && ctx.wifi_rssi) {
            status_bar_->SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
        }
        if (ctx.read_charge) {
            const auto snap = ctx.read_charge();
            int pct = -1;
            if (!snap.no_battery && ctx.read_battery) {
                int mv = 0;
                ctx.read_battery(&mv, &pct);
            }
            status_bar_->SetBattery(pct, snap.charging || snap.full);
        }
    }

    // 收集运行时数据
    const bool   wifi_on = ctx.wifi_connected ? ctx.wifi_connected() : false;
    const int    rssi    = ctx.wifi_rssi      ? ctx.wifi_rssi()      : 0;
    std::string  ip      = Wifi::Get().GetIp();
    cred::Credentials c;
    cred::Load(c);

    int battery_mv = 0, battery_pct = -1;
    if (ctx.read_battery) ctx.read_battery(&battery_mv, &battery_pct);

    ChargeStatus::Snapshot charge{};
    if (ctx.read_charge) charge = ctx.read_charge();
    (void)c;

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char mac_str[18];
    std::snprintf(mac_str, sizeof(mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    // 内存:DRAM 堆(MALLOC_CAP_INTERNAL) + PSRAM 堆(MALLOC_CAP_SPIRAM)
    const size_t dram_free  = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t dram_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t psram_free  = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);

    // 存储:LittleFS partition label "storage"(跟 cache::Init 一致)
    size_t fs_total = 0, fs_used = 0;
    esp_littlefs_info("storage", &fs_total, &fs_used);

    char buf[1024];
    std::snprintf(buf, sizeof(buf),
                  "WiFi    %s   %d dBm\n"
                  "SSID    %s\n"
                  "IP      %s\n"
                  "\n"
                  "电量    %d%%   %d mV\n"
                  "状态    %s\n"
                  "\n"
                  "DRAM    %u / %u KB\n"
                  "PSRAM   %u / %u MB\n"
                  "存储    %u / %u KB\n"
                  "\n"
                  "MAC     %s\n"
                  "固件    %s\n"
                  "服务器  %s",
                  wifi_on ? "已连接" : "未连接",
                  rssi,
                  c.wifi_ssid.empty() ? "-" : c.wifi_ssid.c_str(),
                  ip.empty() ? "-" : ip.c_str(),
                  battery_pct < 0 ? 0 : battery_pct,
                  battery_mv,
                  ChargeText(charge),
                  static_cast<unsigned>(dram_free / 1024),
                  static_cast<unsigned>(dram_total / 1024),
                  static_cast<unsigned>(psram_free / (1024 * 1024)),
                  static_cast<unsigned>(psram_total / (1024 * 1024)),
                  static_cast<unsigned>(fs_used / 1024),
                  static_cast<unsigned>(fs_total / 1024),
                  mac_str,
                  CONFIG_APP_PROJECT_VER,
                  c.server_url.empty() ? "-" : c.server_url.c_str());
    lv_label_set_text(info_, buf);
}

void DeviceInfoPage::SyncRender(SceneContext& ctx) {
    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}
