#include "device_info_page.h"

#include <esp_heap_caps.h>
#include <esp_littlefs.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <sdkconfig.h>
#include <cstdio>

#include "cred_store.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "scene_stack.h"
#include "theme.h"
#include "wifi.h"

namespace {
constexpr char kTag[] = "DeviceInfo";

// thumb 几何来自 theme.h,与 MenuList 共用。
constexpr int kThumbPadTop = 12;  // 跟 MenuList 对称 pad 一致
constexpr int kThumbPadBot = 12;

const char* ChargeText(const ChargeStatus::Snapshot& s) {
    if (s.no_battery)
        return "无电池";
    if (s.full)
        return "已充满";
    if (s.charging)
        return "充电中";
    if (s.power_present)
        return "已接电源";
    return "电池供电";
}
}  // namespace

DeviceInfoPage::DeviceInfoPage()  = default;
DeviceInfoPage::~DeviceInfoPage() = default;

void DeviceInfoPage::OnEnter(SceneContext& ctx) {
    LoadStaticInfo();

    if (!ctx.epd->Lock(2000))
        return;

    root_ = CreateFullscreenRoot();

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
    lv_obj_set_style_text_font(info_, &Zfull_16, 0);
    lv_obj_set_style_text_color(info_, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(info_, 4, 0);
    lv_obj_set_style_text_align(info_, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_width(info_, LV_HOR_RES - 48);
    lv_label_set_long_mode(info_, LV_LABEL_LONG_WRAP);
    lv_obj_set_pos(info_, 24, 12);  // 相对 scroll_area_,顶部留 12px

    // thumb 挂在 root_ 而不是 scroll_area_,否则会跟着内容一起滚。
    thumb_ = lv_obj_create(root_);
    lv_obj_set_style_bg_color(thumb_, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(thumb_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(thumb_, 0, 0);
    lv_obj_set_style_radius(thumb_, 0, 0);
    lv_obj_set_style_pad_all(thumb_, 0, 0);
    lv_obj_clear_flag(thumb_, LV_OBJ_FLAG_SCROLLABLE);

    (void)Refresh(ctx);
    UpdateThumb();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 看 diff>=30% 兜底升 full。
    ctx.epd->RequestUrgentPartialRefresh();
}

void DeviceInfoPage::OnExit(SceneContext& ctx) {
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        scroll_area_ = nullptr;
        info_        = nullptr;
        thumb_       = nullptr;
    });
}

void DeviceInfoPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_)
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort: {
            // 一屏装不下,UP/DOWN 翻看;ENTER 短按返回。
            // UP = 视野上移(看上方内容)、DOWN = 视野下移(看下方内容)。
            constexpr int kScrollStep = 80;  // 一次约 4 行(20px/行)
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    ScrollBy(ctx, -kScrollStep);
                    break;
                case ButtonId::kDown:
                    ScrollBy(ctx, +kScrollStep);
                    break;
                case ButtonId::kEnter:
                    ctx.stack->RequestPop();
                    break;
            }
            break;
        }
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter)
                ctx.stack->RequestPop();
            break;
        case UiEventKind::kChargeChanged:
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kWifiStateChanged:
        case UiEventKind::kMinuteTick:
            // 内容真变了才 partial,避免一小时 60 次 MinuteTick 都触发刷新
            if (Refresh(ctx)) {
                UpdateThumb();  // 内容长度变了,thumb 比例也得跟
                SyncRender(ctx);
            }
            break;
        default:
            break;
    }
}

void DeviceInfoPage::ScrollBy(SceneContext& ctx, int dy_view) {
    if (!scroll_area_)
        return;
    // dy_view 正值 = 视野往下看(看到下方内容);负值 = 视野上移看上方。
    // 用 scroll_to_y 显式 clamp,到顶/底再按方向键就完全无效(不再触发 EPD 刷新)。
    const int cur_y = lv_obj_get_scroll_y(scroll_area_);
    const int max_y = cur_y + lv_obj_get_scroll_bottom(scroll_area_);
    int       new_y = cur_y + dy_view;
    if (new_y < 0)
        new_y = 0;
    if (new_y > max_y)
        new_y = max_y;
    if (new_y == cur_y)
        return;  // 已到边界,什么都不做
    lv_obj_scroll_to_y(scroll_area_, new_y, LV_ANIM_OFF);
    UpdateThumb();
    SyncRender(ctx);
}

void DeviceInfoPage::UpdateThumb() {
    if (!thumb_ || !scroll_area_)
        return;
    // 强制把 layout 算完再读 scroll_bottom:OnEnter 刚 set_text,LVGL 还没跑布局,
    // 直接读 scroll_bottom 会拿到 0 → thumb_h 偏短;第一次按方向键再 UpdateThumb
    // 时已经经过一轮 redraw,值才正常。这里同步一次避免初始视觉跳变。
    lv_obj_update_layout(scroll_area_);
    // visible_h 取 root 内对称 pad 之间的范围,跟 MenuList 视觉一致。
    const int track_h    = LV_VER_RES - theme::kStatusBarHeight - kThumbPadTop - kThumbPadBot;
    const int scroll_y   = lv_obj_get_scroll_y(scroll_area_);
    const int scroll_bot = lv_obj_get_scroll_bottom(scroll_area_);
    const int max_scroll = scroll_y + scroll_bot;  // 总可滚距离 = 内容高 - 视口高
    // 内容比视口短:不需要 thumb,隐藏。
    if (max_scroll <= 0) {
        lv_obj_add_flag(thumb_, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    lv_obj_clear_flag(thumb_, LV_OBJ_FLAG_HIDDEN);
    const int visible_h = lv_obj_get_height(scroll_area_);
    const int content_h = visible_h + max_scroll;
    int       thumb_h   = (track_h * visible_h) / content_h;
    if (thumb_h < theme::kThumbMinH)
        thumb_h = theme::kThumbMinH;
    if (thumb_h > track_h)
        thumb_h = track_h;
    const int thumb_y_max = track_h - thumb_h;
    const int thumb_y     = (thumb_y_max * scroll_y) / max_scroll;
    lv_obj_set_size(thumb_, theme::kThumbW, thumb_h);
    lv_obj_set_pos(thumb_, LV_HOR_RES - theme::kThumbW - theme::kThumbRightPad,
                   theme::kStatusBarHeight + kThumbPadTop + thumb_y);
}

void DeviceInfoPage::LoadStaticInfo() {
    cred::Credentials c;
    cred::Load(c);
    wifi_ssid_  = std::move(c.wifi_ssid);
    server_url_ = std::move(c.server_url);

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    std::snprintf(mac_str_, sizeof(mac_str_), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4],
                  mac[5]);
}

bool DeviceInfoPage::Refresh(SceneContext& ctx) {
    if (!info_)
        return false;

    // 同时更新状态栏(让 wifi/电量图标也跟随当前实际状态)
    if (status_bar_) {
        RefreshStatusBarFromSensors(ctx, *status_bar_);
    }

    // 收集运行时数据。浮动值粗化颗粒,跟 DRAM/PSRAM 一起保护 last_text_ 缓存:
    //   RSSI 1-2 dBm 抖动 → 颗粒 5 dBm
    //   battery mV 几 mV 抖动 → 颗粒 50 mV
    // C++11 起整数除法对负数向 0 取整,RSSI 负值 quantize 仍正确。
    const bool        wifi_on        = ctx.wifi_connected ? ctx.wifi_connected() : false;
    const int         rssi_raw       = ctx.wifi_rssi ? ctx.wifi_rssi() : 0;
    const int         rssi           = (rssi_raw / 5) * 5;
    const std::string ip             = Wifi::Get().GetIp();
    int               battery_mv_raw = 0, battery_pct = -1;
    if (ctx.read_battery)
        ctx.read_battery(&battery_mv_raw, &battery_pct);
    const int battery_mv = (battery_mv_raw / 50) * 50;

    ChargeStatus::Snapshot charge{};
    if (ctx.read_charge)
        charge = ctx.read_charge();

    // 内存:DRAM 堆(MALLOC_CAP_INTERNAL) + PSRAM 堆(MALLOC_CAP_SPIRAM)。
    // 颗粒粗化是为了保护 last_text_ 缓存:DRAM free 实际秒级抖动几 KB,
    // 1 KB 颗粒会让 buf 几乎每次都不同,缓存命中率为零 → MinuteTick / 充电 /
    // 电量事件每次都触发 partial 刷,EPD 累计 8 次自动 full 闪屏。
    //   DRAM:KB 单位,颗粒 10 KB(total ~330 KB,数字直观)
    //   PSRAM:MB 单位,颗粒 1 MB(total 8 MB,KB 数字太长)
    //   存储:KB 单位,颗粒 100 KB(LittleFS 写入慢,本来就稳)
    auto         round_kb_10    = [](size_t bytes) -> size_t { return (bytes / 1024 / 10) * 10; };
    auto         round_kb_100   = [](size_t bytes) -> size_t { return (bytes / 1024 / 100) * 100; };
    auto         to_mb          = [](size_t bytes) -> size_t { return bytes / (1024 * 1024); };
    const size_t dram_free_kb   = round_kb_10(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    const size_t dram_total_kb  = round_kb_10(heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    const size_t psram_free_mb  = to_mb(heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    const size_t psram_total_mb = to_mb(heap_caps_get_total_size(MALLOC_CAP_SPIRAM));

    // 存储:LittleFS partition label "storage"(跟 cache::Init 一致)
    size_t fs_total = 0, fs_used = 0;
    if (esp_littlefs_info("storage", &fs_total, &fs_used) != ESP_OK) {
        ESP_LOGW(kTag, "esp_littlefs_info failed");
    }
    const size_t fs_used_kb  = round_kb_100(fs_used);
    const size_t fs_total_kb = round_kb_100(fs_total);

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
                  wifi_on ? "已连接" : "未连接", rssi, wifi_ssid_.empty() ? "-" : wifi_ssid_.c_str(),
                  ip.empty() ? "-" : ip.c_str(), battery_pct < 0 ? 0 : battery_pct, battery_mv, ChargeText(charge),
                  static_cast<unsigned>(dram_free_kb), static_cast<unsigned>(dram_total_kb),
                  static_cast<unsigned>(psram_free_mb), static_cast<unsigned>(psram_total_mb),
                  static_cast<unsigned>(fs_used_kb), static_cast<unsigned>(fs_total_kb), mac_str_,
                  CONFIG_APP_PROJECT_VER, server_url_.empty() ? "-" : server_url_.c_str());
    // 内容跟上次完全相同就不更新 LVGL,直接告诉调用方"无需刷"
    if (last_text_ == buf)
        return false;
    last_text_.assign(buf);
    lv_label_set_text(info_, buf);
    return true;
}
