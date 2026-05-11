#include "boot_splash_scene.h"

#include <cstdio>
#include <cstring>
#include <esp_log.h>
#include <esp_mac.h>
#include <memory>
#include <sdkconfig.h>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../display/epd_ssd1683.h"
#include "../net/cred_store.h"
#include "../ui/theme.h"
#include "frame_scene.h"
#include "settings_scene.h"

namespace {
constexpr char kTag[] = "BootSplash";

// SoftAP SSID 计算逻辑跟 captive_portal.cc HandleRoot 一致,保持一致避免文案
// 跟实际 AP 名对不上。
void FormatApSsid(char* out, size_t cap) {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    std::snprintf(out, cap, "%s-%02X%02X",
                  CONFIG_SLATE_AP_SSID_PREFIX, mac[4], mac[5]);
}

// 把 BootStage(event_bus.h)映射成 SplashState。
BootSplashScene::State MapBootStage(BootStage s) {
    switch (s) {
        case BootStage::kInitializing:      return BootSplashScene::State::kInitializing;
        case BootStage::kProvisioning:      return BootSplashScene::State::kProvisioning;
        case BootStage::kWifiConnecting:    return BootSplashScene::State::kWifiConnecting;
        case BootStage::kWifiFailed:        return BootSplashScene::State::kWifiFailed;
        case BootStage::kSntp:              return BootSplashScene::State::kSntp;
        case BootStage::kRegistering:       return BootSplashScene::State::kRegistering;
        case BootStage::kServerUnreachable: return BootSplashScene::State::kServerUnreachable;
        case BootStage::kAwaitingPair:      return BootSplashScene::State::kAwaitingPair;
        case BootStage::kAwaitingGroup:     return BootSplashScene::State::kAwaitingGroup;
        case BootStage::kNetError:          return BootSplashScene::State::kNetError;
    }
    return BootSplashScene::State::kInitializing;
}

}  // namespace

void BootSplashScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in OnEnter");
        return;
    }

    // NVS 此刻已 init(InitStorage 早于 StartUiLoop)。无 cred → 配网模式。
    cred::Credentials creds;
    state_ = cred::Load(creds) ? State::kInitializing : State::kProvisioning;

    auto* screen = lv_screen_active();
    root_ = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    // 主文案(中文 + 阿拉伯数字),Awaiting pair 状态下放在码上方做提示。
    text_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(text_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(text_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(text_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(text_label_, 8, 0);
    lv_label_set_long_mode(text_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(text_label_, LV_HOR_RES - 32);

    // 配对码大字(仅 ASCII A-Z 0-9,montserrat_48 即可)。默认隐藏,kAwaitingPair 时显示。
    code_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(code_label_, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(code_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(code_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_letter_space(code_label_, 4, 0);
    lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);

    // 应急逃生 hint:始终在底部,长按 ENTER 进设置(配网恢复 / 看设备信息 / 工厂重置)。
    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_label_, "长按确认 进入设置");
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -16);

    Render(ctx);

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void BootSplashScene::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    if (root_) {
        lv_obj_del(root_);
        root_       = nullptr;
        text_label_ = nullptr;
        code_label_ = nullptr;
        hint_label_ = nullptr;
    }
    ctx.epd->Unlock();
}

void BootSplashScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    // 应急逃生:长按 ENTER push 设置页 — 即使同步未完成、网络断开,
    // 用户仍能调音量 / 看设备信息 / 重新配网 / 恢复出厂。
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        ESP_LOGI(kTag, "Long Enter on splash -> push Settings (emergency exit)");
        ctx.stack->RequestPush(std::make_unique<SettingsScene>());
        return;
    }

    if (e.kind == UiEventKind::kGroupReady) {
        ESP_LOGI(kTag, "GroupReady gid=%s frames=%d default=%d -> switch to FrameScene",
                 e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx);
        ctx.stack->RequestReplace(std::make_unique<FrameScene>(
            e.u.group.gid, e.u.group.frame_count, e.u.group.default_idx));
        return;
    }

    bool need_render = false;

    if (e.kind == UiEventKind::kBootStage) {
        State target = MapBootStage(e.u.boot_stage.stage);
        // kProvisioning 一旦确认就锁住:避免后续 stray 事件把"配网模式"覆盖。
        if (state_ == State::kProvisioning && target != State::kProvisioning) {
            return;
        }
        state_ = target;
        if (target == State::kWifiConnecting) {
            std::strncpy(ssid_, e.u.boot_stage.ssid, sizeof(ssid_) - 1);
            ssid_[sizeof(ssid_) - 1] = '\0';
        }
        if (target == State::kAwaitingPair) {
            std::strncpy(pair_code_, e.u.boot_stage.pair_code, sizeof(pair_code_) - 1);
            pair_code_[sizeof(pair_code_) - 1] = '\0';
        }
        need_render = true;
    } else if (e.kind == UiEventKind::kBound) {
        if (state_ != State::kProvisioning) {
            state_ = State::kAwaitingGroup;
            need_render = true;
        }
    } else if (e.kind == UiEventKind::kUnbound) {
        if (state_ != State::kProvisioning) {
            state_ = State::kAwaitingPair;
            std::strncpy(pair_code_, e.u.unbound.pair_code, sizeof(pair_code_) - 1);
            pair_code_[sizeof(pair_code_) - 1] = '\0';
            need_render = true;
        }
    } else if (e.kind == UiEventKind::kSyncProgress) {
        // 节流：current 不变 / 距上次 < 500 ms 都跳过
        const uint8_t    cur = e.u.progress.current;
        const TickType_t now = xTaskGetTickCount();
        if (cur == last_progress_current_) return;
        if ((now - last_progress_tick_) < pdMS_TO_TICKS(500)) return;
        last_progress_current_ = cur;
        last_progress_tick_    = now;
        progress_cur_   = cur;
        progress_total_ = e.u.progress.total;
        if (state_ != State::kProvisioning) {
            state_ = State::kSyncProgress;
            need_render = true;
        }
    } else if (e.kind == UiEventKind::kSyncFinished && !e.u.sync.ok) {
        // 失败仅在不是 awaiting_* 状态(那两种由后端权威 state 推过来,不要被网抖盖)
        // 时切到「网络异常」。
        if (state_ != State::kProvisioning &&
            state_ != State::kAwaitingPair &&
            state_ != State::kAwaitingGroup) {
            state_ = State::kNetError;
            need_render = true;
        }
    }

    if (need_render) Render(ctx);
}

void BootSplashScene::Render(SceneContext& ctx) {
    if (!text_label_ || !code_label_) return;

    char buf[192];
    bool show_code = false;

    switch (state_) {
        case State::kInitializing:
            std::snprintf(buf, sizeof(buf), "正在启动…");
            break;
        case State::kProvisioning: {
            char ap_ssid[24];
            FormatApSsid(ap_ssid, sizeof(ap_ssid));
            std::snprintf(buf, sizeof(buf),
                          "配网模式\n\n"
                          "请连接 Wi-Fi：\n%s\n\n"
                          "浏览器打开：\nhttp://192.168.4.1",
                          ap_ssid);
            break;
        }
        case State::kWifiConnecting:
            std::snprintf(buf, sizeof(buf), "连接 Wi-Fi 中\n%s",
                          ssid_[0] ? ssid_ : "");
            break;
        case State::kWifiFailed:
            std::snprintf(buf, sizeof(buf), "Wi-Fi 连接失败\n\n长按 确认 重新配网");
            break;
        case State::kSntp:
            std::snprintf(buf, sizeof(buf), "对时中…");
            break;
        case State::kRegistering:
            std::snprintf(buf, sizeof(buf), "注册设备中…");
            break;
        case State::kServerUnreachable:
            std::snprintf(buf, sizeof(buf), "服务器无响应,稍后重试…");
            break;
        case State::kAwaitingPair:
            std::snprintf(buf, sizeof(buf), "在管理端【添加设备】中输入:");
            show_code = true;
            break;
        case State::kAwaitingGroup:
            // 后端 claim 已自动绑「第一个相册」、create 第一个相册也会反向绑;
            // 走到这里 = owner 一个相册都没有,直接告诉用户去创建。
            std::snprintf(buf, sizeof(buf), "已绑定\n\n请在管理端创建相册");
            break;
        case State::kNetError:
            std::snprintf(buf, sizeof(buf), "网络异常,稍后自动重试…");
            break;
        case State::kSyncProgress:
            std::snprintf(buf, sizeof(buf), "正在准备\n%u / %u",
                          progress_cur_, progress_total_);
            break;
    }

    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_label_set_text(text_label_, buf);
    if (show_code) {
        // 配对码居中显示,提示文案放在码上方约 60px。
        lv_label_set_text(code_label_, pair_code_);
        lv_obj_clear_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(text_label_, LV_ALIGN_CENTER, 0, -52);
        lv_obj_align(code_label_, LV_ALIGN_CENTER, 0, 24);
    } else {
        lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(text_label_, LV_ALIGN_CENTER, 0, 0);
    }
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}
