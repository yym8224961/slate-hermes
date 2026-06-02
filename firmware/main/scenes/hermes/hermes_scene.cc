#include "scenes/hermes/hermes_scene.h"

#include <esp_log.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "drivers/display/epd_ssd1683.h"
#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "hermes/hermes_service.h"
#include "scenes/core/scene_stack.h"
#include "scenes/settings/settings_scene.h"
#include "ui/theme.h"
#include "utils/utf8_utils.h"

namespace {
constexpr char kTag[]                = "hermes_scene";
constexpr int  kStandbyBottomReserve = 46;

int CenterY(int y) { return y - (LV_VER_RES / 2); }
int StandbyCenterY() {
    return theme::kStatusBarHeight +
           (LV_VER_RES - theme::kStatusBarHeight - kStandbyBottomReserve) / 2;
}

std::string DisplayText(const std::string& text) {
    return util::TrimForScreen(util::SanitizeForScreen(text), 120);
}

std::string MsgKey(const hermes::HermesSnapshot& snap) {
    std::string key;
    for (const auto& msg : snap.messages) {
        key += msg.role;
        key.push_back('\x1F');
        key += util::SanitizeForScreen(msg.text);
        key.push_back('\x1E');
    }
    return key;
}

void StyleTransparent(lv_obj_t* obj) {
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
}

void StyleBubble(lv_obj_t* bubble) {
    lv_obj_set_style_bg_opa(bubble, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(bubble, 1, 0);
    lv_obj_set_style_border_color(bubble, lv_color_black(), 0);
    lv_obj_set_style_radius(bubble, 8, 0);
    lv_obj_set_style_pad_left(bubble, 8, 0);
    lv_obj_set_style_pad_right(bubble, 8, 0);
    lv_obj_set_style_pad_top(bubble, 6, 0);
    lv_obj_set_style_pad_bottom(bubble, 6, 0);
    lv_obj_clear_flag(bubble, LV_OBJ_FLAG_SCROLLABLE);
}
}  // namespace

hermes::HermesService* HermesScene::Service(SceneContext& ctx) {
    if (!service_) {
        service_ = &hermes::HermesService::Get();
    }
    return service_;
}

void HermesScene::EnsureServiceStarted(SceneContext& ctx) {
    if (service_entered_) return;

    auto* svc = Service(ctx);
    if (!svc->IsStarted()) {
        svc->Start(ctx.audio);
    }
    svc->EnterMode();
    service_entered_ = true;
}

void HermesScene::OnEnter(SceneContext& ctx) {
    ESP_LOGD(kTag, "enter");

    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "enter failed: epd lock timeout");
        EnsureServiceStarted(ctx);
        return;
    }

    CreateLayout();
    RefreshStatusBarFromSensors(ctx, *status_bar_);
    EnsureServiceStarted(ctx);
    RenderContent();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
    ESP_LOGD(kTag, "enter done");
}

void HermesScene::OnExit(SceneContext& ctx) {
    ESP_LOGD(kTag, "exit");
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        standby_icon_label_ = nullptr;
        standby_body_label_ = nullptr;
        system_label_       = nullptr;
        chat_area_          = nullptr;
        chat_content_       = nullptr;
        chat_empty_label_   = nullptr;
        hint_label_         = nullptr;
        rendered_msg_count_ = 0;
        rendered_msg_key_.clear();
    });
    if (service_entered_) {
        if (auto* svc = Service(ctx))
            svc->LeaveMode();
        service_entered_ = false;
    }
}

void HermesScene::CreateLayout() {
    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("Hermes");

    // Standby icon
    standby_icon_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_icon_label_, &font_awesome_30_1, 0);
    lv_obj_set_style_text_color(standby_icon_label_, lv_color_black(), 0);
    lv_label_set_text(standby_icon_label_, FONT_AWESOME_MICROCHIP_AI);
    lv_obj_align(standby_icon_label_, LV_ALIGN_CENTER, 0, CenterY(StandbyCenterY() - 26));

    // Standby text
    standby_body_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_body_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(standby_body_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(standby_body_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(standby_body_label_, "按确认开始说话");
    lv_obj_set_width(standby_body_label_, LV_HOR_RES - 48);
    lv_obj_align(standby_body_label_, LV_ALIGN_CENTER, 0, CenterY(StandbyCenterY() + 26));

    // System message
    system_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(system_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(system_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(system_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(system_label_, 6, 0);
    lv_label_set_long_mode(system_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(system_label_, LV_HOR_RES - 40);

    // Chat area
    chat_area_ = lv_obj_create(root_);
    lv_obj_set_size(chat_area_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(chat_area_, 0, theme::kStatusBarHeight);
    StyleTransparent(chat_area_);

    chat_content_ = lv_obj_create(chat_area_);
    lv_obj_set_size(chat_content_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
    lv_obj_set_pos(chat_content_, 0, 0);
    lv_obj_set_style_bg_opa(chat_content_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(chat_content_, 0, 0);
    lv_obj_set_style_pad_left(chat_content_, 0, 0);
    lv_obj_set_style_pad_right(chat_content_, 0, 0);
    lv_obj_set_style_pad_top(chat_content_, 14, 0);
    lv_obj_set_style_pad_bottom(chat_content_, 14, 0);
    lv_obj_set_style_pad_row(chat_content_, 8, 0);
    lv_obj_set_scroll_dir(chat_content_, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(chat_content_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_flex_flow(chat_content_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(chat_content_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);

    chat_empty_label_ = lv_label_create(chat_area_);
    lv_obj_set_style_text_font(chat_empty_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(chat_empty_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(chat_empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(chat_empty_label_, "...");
    lv_obj_set_width(chat_empty_label_, LV_HOR_RES - 48);
    lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);

    // Hint
    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(hint_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint_label_, LV_HOR_RES - 16);
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -10);
}

void HermesScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_) return;

    switch (e.kind) {
        case UiEventKind::kButtonShort:
            if (e.u.button.btn == ButtonId::kEnter) {
                if (auto* svc = Service(ctx))
                    svc->ToggleChat();
                SyncAndRefresh(ctx);
            } else if (e.u.button.btn == ButtonId::kUp) {
                if (auto* svc = Service(ctx))
                    svc->AdjustVolume(+1);
                SyncAndRefresh(ctx);
            } else if (e.u.button.btn == ButtonId::kDown) {
                if (auto* svc = Service(ctx))
                    svc->AdjustVolume(-1);
                SyncAndRefresh(ctx);
            }
            break;

        case UiEventKind::kButtonDouble:
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGD(kTag, "double enter: pop");
                if (auto* svc = Service(ctx))
                    svc->LeaveMode();
                ctx.stack->RequestPop();
            }
            break;

        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) {
                ESP_LOGD(kTag, "long enter: push settings");
                ctx.stack->RequestPush(std::make_unique<SettingsScene>());
            }
            break;

        case UiEventKind::kHermesChanged:
            SyncAndRefresh(ctx);
            break;

        case UiEventKind::kChargeChanged:
        case UiEventKind::kBatteryUpdated:
        case UiEventKind::kWifiStateChanged:
        case UiEventKind::kMinuteTick:
            if (root_) {
                SyncRender(ctx, [this, &ctx]() {
                    if (status_bar_)
                        RefreshStatusBarFromSensors(ctx, *status_bar_);
                    RenderContent();
                });
            }
            break;

        default:
            break;
    }
}

void HermesScene::SyncAndRefresh(SceneContext& ctx) {
    if (!root_) return;
    SyncRender(ctx, [this]() { RenderContent(); });
}

void HermesScene::RenderContent() {
    if (!root_ || !status_bar_ || !system_label_ || !hint_label_) return;
    if (!service_) return;

    const auto snap = service_->Snapshot();
    UpdateStatusBarTitle(snap);
    HideContentViews();

    switch (snap.state) {
        case hermes::HermesState::kIdle: {
            lv_obj_clear_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
            lv_obj_clear_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);

            // Show recent messages if any
            if (!snap.messages.empty()) {
                lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
                lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
                RenderMessages(snap);
            }

            lv_label_set_text(hint_label_, "确认 开始说话   上/下 调音量   双击 返回");
            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
        }
        case hermes::HermesState::kRecording: {
            char buf[64];
            snprintf(buf, sizeof(buf), "正在听... %d秒", snap.record_sec);
            lv_label_set_text(system_label_, buf);
            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
            lv_label_set_text(hint_label_, "确认 说完发送   上/下 调音量");
            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
        }
        case hermes::HermesState::kSending:
            lv_label_set_text(system_label_, "发送中...");
            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
        case hermes::HermesState::kThinking:
            lv_label_set_text(system_label_, "Hermes正在思考...");
            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
        case hermes::HermesState::kSpeaking:
            if (!snap.messages.empty()) {
                RenderMessages(snap);
            } else {
                // Show status text if no messages yet
                lv_label_set_text(system_label_, DisplayText(snap.status).c_str());
                lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
                lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
            }
            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
        case hermes::HermesState::kError:
            lv_label_set_text(system_label_, snap.error.empty() ? "出错了" : snap.error.c_str());
            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
            lv_label_set_text(hint_label_, "确认 重试   双击 返回");
            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
            break;
    }
}

void HermesScene::HideContentViews() {
    lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
}

void HermesScene::RenderMessages(const hermes::HermesSnapshot& snap) {
    lv_obj_clear_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);

    const std::string mk = MsgKey(snap);
    const bool changed = rendered_state_ != static_cast<int>(snap.state) ||
                         rendered_msg_count_ != snap.messages.size() ||
                         rendered_msg_key_ != mk;

    if (changed) {
        ClearMessages();
        for (const auto& msg : snap.messages)
            AppendBubble(msg.role, msg.text);
        rendered_msg_count_ = snap.messages.size();
        rendered_msg_key_   = mk;
    }

    if (chat_content_ && lv_obj_get_child_cnt(chat_content_) == 0) {
        lv_obj_clear_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
    } else {
        lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
    }

    rendered_state_ = static_cast<int>(snap.state);
}

void HermesScene::ClearMessages() {
    if (!chat_content_) return;
    lv_obj_clean(chat_content_);
    rendered_msg_count_ = 0;
    rendered_msg_key_.clear();
}

void HermesScene::AppendBubble(const std::string& role, const std::string& text) {
    if (text.empty()) return;

    const std::string display = DisplayText(text);
    if (display.empty()) return;

    const bool is_user = role == "user";

    lv_obj_t* row = lv_obj_create(chat_content_);
    lv_obj_set_width(row, LV_HOR_RES);
    lv_obj_set_height(row, LV_SIZE_CONTENT);
    lv_obj_set_style_flex_grow(row, 0, 0);
    StyleTransparent(row);

    lv_obj_t* bubble = lv_obj_create(row);
    StyleBubble(bubble);
    lv_obj_t* label = lv_label_create(bubble);
    lv_obj_set_style_text_font(label, &Zfull_16, 0);
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(label, 4, 0);
    LayoutBubble(bubble, label, display);
    lv_obj_set_height(row, lv_obj_get_height(bubble) + 2);

    if (is_user)
        lv_obj_align(bubble, LV_ALIGN_RIGHT_MID, -18, 0);
    else
        lv_obj_align(bubble, LV_ALIGN_LEFT_MID, 18, 0);

    lv_obj_scroll_to_view_recursive(row, LV_ANIM_OFF);
}

void HermesScene::LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text) {
    lv_label_set_text(label, text.c_str());
    lv_obj_set_width(label, LV_SIZE_CONTENT);
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
    lv_obj_update_layout(label);

    constexpr int kMaxW = 308;
    constexpr int kMinW = 36;
    const int measured = lv_obj_get_width(label);
    const int text_w   = std::clamp(measured, kMinW, kMaxW);
    if (measured > kMaxW) {
        lv_obj_set_width(label, kMaxW);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    } else {
        lv_obj_set_width(label, text_w);
    }

    lv_obj_set_width(bubble, text_w + 18);
    lv_obj_set_height(bubble, LV_SIZE_CONTENT);
    lv_obj_update_layout(bubble);
}

void HermesScene::UpdateStatusBarTitle(const hermes::HermesSnapshot& snap) {
    switch (snap.state) {
        case hermes::HermesState::kIdle:      status_bar_->SetCaption("Hermes"); break;
        case hermes::HermesState::kRecording:  status_bar_->SetCaption("Hermes - 录音"); break;
        case hermes::HermesState::kSending:    status_bar_->SetCaption("Hermes - 发送"); break;
        case hermes::HermesState::kThinking:   status_bar_->SetCaption("Hermes - 思考"); break;
        case hermes::HermesState::kSpeaking:   status_bar_->SetCaption("Hermes - 回复"); break;
        case hermes::HermesState::kError:      status_bar_->SetCaption("Hermes - !"); break;
    }
    status_bar_->SetCaptionIcon(nullptr);
}
