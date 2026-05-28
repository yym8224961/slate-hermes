#include "chat_scene.h"

#include <esp_log.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>

#include "epd_ssd1683.h"
#include "event_bus.h"
#include "scene_stack.h"
#include "settings_scene.h"
#include "theme.h"
#include "xiaozhi_chat_service.h"

namespace {
constexpr char kTag[]                    = "ChatScene";
constexpr int  kStandbyBottomHintReserve = 46;

int RootCenterYOffset(int y) {
    return y - (LV_VER_RES / 2);
}

int StandbyContentCenterY() {
    return theme::kStatusBarHeight + (LV_VER_RES - theme::kStatusBarHeight - kStandbyBottomHintReserve) / 2;
}

std::string TrimForScreen(const std::string& text, size_t max_len) {
    if (max_len == 0 || text.empty())
        return "";

    size_t pos   = 0;
    size_t count = 0;
    while (pos < text.size() && count < max_len) {
        const auto ch   = static_cast<unsigned char>(text[pos]);
        size_t     step = 1;
        if ((ch & 0x80) == 0) {
            step = 1;
        } else if ((ch & 0xE0) == 0xC0) {
            step = 2;
        } else if ((ch & 0xF0) == 0xE0) {
            step = 3;
        } else if ((ch & 0xF8) == 0xF0) {
            step = 4;
        }
        if (pos + step > text.size())
            break;
        bool valid = true;
        for (size_t i = 1; i < step; ++i) {
            const auto cont = static_cast<unsigned char>(text[pos + i]);
            if ((cont & 0xC0) != 0x80) {
                valid = false;
                break;
            }
        }
        if (!valid)
            step = 1;
        pos += step;
        ++count;
    }

    if (pos >= text.size())
        return text;
    return text.substr(0, pos) + "...";
}

bool DecodeUtf8Codepoint(const std::string& text, size_t pos, uint32_t& cp, size_t& step) {
    if (pos >= text.size())
        return false;

    const auto ch = static_cast<unsigned char>(text[pos]);
    if ((ch & 0x80) == 0) {
        cp   = ch;
        step = 1;
        return true;
    }

    uint32_t value = 0;
    if ((ch & 0xE0) == 0xC0) {
        value = ch & 0x1F;
        step  = 2;
    } else if ((ch & 0xF0) == 0xE0) {
        value = ch & 0x0F;
        step  = 3;
    } else if ((ch & 0xF8) == 0xF0) {
        value = ch & 0x07;
        step  = 4;
    } else {
        step = 1;
        return false;
    }

    if (pos + step > text.size()) {
        step = 1;
        return false;
    }
    for (size_t i = 1; i < step; ++i) {
        const auto cont = static_cast<unsigned char>(text[pos + i]);
        if ((cont & 0xC0) != 0x80) {
            step = 1;
            return false;
        }
        value = (value << 6) | (cont & 0x3F);
    }

    if ((step == 2 && value < 0x80) || (step == 3 && value < 0x800) || (step == 4 && value < 0x10000) ||
        value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) {
        step = 1;
        return false;
    }

    cp = value;
    return true;
}

bool IsUnsupportedDisplayCodepoint(uint32_t cp) {
    if (cp == 0xFFFD)
        return true;
    if (cp >= 0xFE00 && cp <= 0xFE0F)
        return true;
    if (cp >= 0xE0100 && cp <= 0xE01EF)
        return true;
    if (cp == 0x200D || (cp >= 0x200B && cp <= 0x200F))
        return true;
    if (cp >= 0x2600 && cp <= 0x27BF)
        return true;
    if (cp >= 0x1F000)
        return true;
    return false;
}

std::string SanitizeForScreen(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    bool previous_space = false;

    for (size_t pos = 0; pos < text.size();) {
        uint32_t cp   = 0;
        size_t   step = 1;
        if (!DecodeUtf8Codepoint(text, pos, cp, step)) {
            pos += step;
            continue;
        }

        if (cp == '\r') {
            pos += step;
            continue;
        }
        if (cp == '\n' || cp == '\t' || cp == 0x00A0) {
            if (!previous_space && !out.empty()) {
                out.push_back(' ');
                previous_space = true;
            }
            pos += step;
            continue;
        }
        if (cp < 0x20 || cp == 0x7F || IsUnsupportedDisplayCodepoint(cp)) {
            pos += step;
            continue;
        }
        if (cp == 0xFF5E) {
            out.push_back('~');
            previous_space = false;
            pos += step;
            continue;
        }

        out.append(text, pos, step);
        previous_space = false;
        pos += step;
    }

    while (!out.empty() && out.back() == ' ')
        out.pop_back();
    return out;
}

std::string DisplayText(const std::string& text) {
    return TrimForScreen(SanitizeForScreen(text), 120);
}

std::string MessagesKey(const xiaozhi::ChatSnapshot& snap) {
    std::string key;
    for (const auto& msg : snap.messages) {
        key += msg.role;
        key.push_back('\x1F');
        key += SanitizeForScreen(msg.text);
        key.push_back('\x1E');
    }
    return key;
}

const char* EmotionIcon(const std::string& emotion, xiaozhi::ChatState state) {
    if (state == xiaozhi::ChatState::kCheckingConfig || state == xiaozhi::ChatState::kConnecting)
        return FONT_AWESOME_THINKING;
    if (state == xiaozhi::ChatState::kError)
        return FONT_AWESOME_SAD;

    if (emotion == "happy")
        return FONT_AWESOME_HAPPY;
    if (emotion == "laughing")
        return FONT_AWESOME_LAUGHING;
    if (emotion == "funny")
        return FONT_AWESOME_FUNNY;
    if (emotion == "sad")
        return FONT_AWESOME_SAD;
    if (emotion == "angry")
        return FONT_AWESOME_ANGRY;
    if (emotion == "crying")
        return FONT_AWESOME_CRYING;
    if (emotion == "loving")
        return FONT_AWESOME_LOVING;
    if (emotion == "embarrassed")
        return FONT_AWESOME_EMBARRASSED;
    if (emotion == "surprised")
        return FONT_AWESOME_SURPRISED;
    if (emotion == "shocked")
        return FONT_AWESOME_SHOCKED;
    if (emotion == "thinking")
        return FONT_AWESOME_THINKING;
    if (emotion == "winking")
        return FONT_AWESOME_WINKING;
    if (emotion == "cool")
        return FONT_AWESOME_COOL;
    if (emotion == "relaxed")
        return FONT_AWESOME_RELAXED;
    if (emotion == "delicious")
        return FONT_AWESOME_DELICIOUS;
    if (emotion == "kissy")
        return FONT_AWESOME_KISSY;
    if (emotion == "confident")
        return FONT_AWESOME_CONFIDENT;
    if (emotion == "sleepy")
        return FONT_AWESOME_SLEEPY;
    if (emotion == "silly")
        return FONT_AWESOME_SILLY;
    if (emotion == "confused")
        return FONT_AWESOME_CONFUSED;
    return FONT_AWESOME_NEUTRAL;
}

std::string StatusTitle(const xiaozhi::ChatSnapshot& snap) {
    switch (snap.state) {
        case xiaozhi::ChatState::kReadyIdle:
            return snap.alert_active && !snap.status.empty() ? snap.status : "小智AI";
        case xiaozhi::ChatState::kListening:
            return snap.status.empty() ? "聆听中" : snap.status;
        case xiaozhi::ChatState::kSpeaking:
            return snap.status.empty() ? "回复中" : snap.status;
        case xiaozhi::ChatState::kConnecting:
        case xiaozhi::ChatState::kCheckingConfig:
        case xiaozhi::ChatState::kAwaitingActivation:
        case xiaozhi::ChatState::kError:
            return snap.status.empty() ? "小智AI" : snap.status;
    }
    return "小智AI";
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

void ChatScene::EnsureServiceStarted(SceneContext& ctx) {
    if (service_entered_)
        return;
    if (!xiaozhi::ChatService::Get().Start(ctx.audio)) {
        if (!root_ || !status_bar_ || !hint_label_)
            return;
        status_bar_->SetCaption("小智异常");
        status_bar_->SetCaptionIcon(FONT_AWESOME_SAD);
        HideContentViews();
        RenderSystemMessage("小智音频初始化失败\n\n请稍后重试或重启设备", false, "");
        lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(hint_label_, "双击确认 返回");
        return;
    }
    xiaozhi::ChatService::Get().EnterMode();
    service_entered_ = true;
}

void ChatScene::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) {
        ESP_LOGW(kTag, "EPD lock timeout in OnEnter");
        EnsureServiceStarted(ctx);
        return;
    }

    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("小智AI");

    code_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(code_label_, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(code_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(code_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_letter_space(code_label_, 4, 0);
    lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);

    standby_icon_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_icon_label_, &font_awesome_30_1, 0);
    lv_obj_set_style_text_color(standby_icon_label_, lv_color_black(), 0);
    lv_label_set_text(standby_icon_label_, FONT_AWESOME_MICROCHIP_AI);
    lv_obj_align(standby_icon_label_, LV_ALIGN_CENTER, 0, RootCenterYOffset(StandbyContentCenterY() - 26));

    standby_body_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(standby_body_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(standby_body_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(standby_body_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(standby_body_label_, "按确认开始聊天");
    lv_obj_set_width(standby_body_label_, LV_HOR_RES - 48);
    lv_obj_align(standby_body_label_, LV_ALIGN_CENTER, 0, RootCenterYOffset(StandbyContentCenterY() + 26));

    system_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(system_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(system_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(system_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(system_label_, 6, 0);
    lv_label_set_long_mode(system_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(system_label_, LV_HOR_RES - 40);

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
    lv_obj_set_style_text_font(chat_empty_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(chat_empty_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(chat_empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(chat_empty_label_, "正在听，想聊点什么？");
    lv_obj_set_width(chat_empty_label_, LV_HOR_RES - 48);
    lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);

    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(hint_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint_label_, LV_HOR_RES - 16);
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -10);

    RefreshStatusBarFromSensors(ctx, *status_bar_);
    EnsureServiceStarted(ctx);
    if (service_entered_) {
        RenderContent();
    }

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
}

void ChatScene::OnExit(SceneContext& ctx) {
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        standby_icon_label_     = nullptr;
        standby_body_label_     = nullptr;
        system_label_           = nullptr;
        code_label_             = nullptr;
        chat_area_              = nullptr;
        chat_content_           = nullptr;
        chat_empty_label_       = nullptr;
        hint_label_             = nullptr;
        rendered_message_count_ = 0;
        rendered_messages_key_.clear();
    });
    if (service_entered_) {
        xiaozhi::ChatService::Get().LeaveMode();
        service_entered_ = false;
    }
}

void ChatScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_)
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kEnter:
                    xiaozhi::ChatService::Get().ToggleChat();
                    break;
                case ButtonId::kUp:
                    xiaozhi::ChatService::Get().AdjustVolume(+1);
                    break;
                case ButtonId::kDown:
                    xiaozhi::ChatService::Get().AdjustVolume(-1);
                    break;
            }
            break;
        case UiEventKind::kButtonDouble:
            if (e.u.button.btn == ButtonId::kEnter) {
                xiaozhi::ChatService::Get().LeaveMode();
                ctx.stack->RequestPop();
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter) {
                xiaozhi::ChatService::Get().StopConversation(true);
                ctx.stack->RequestPush(std::make_unique<SettingsScene>());
            }
            break;
        case UiEventKind::kXiaozhiChanged:
            Render(ctx);
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

void ChatScene::Render(SceneContext& ctx, bool full) {
    if (!root_)
        return;
    SyncRender(ctx, [this]() { RenderContent(); }, full);
}

void ChatScene::RenderContent() {
    if (!root_ || !status_bar_ || !system_label_ || !code_label_ || !hint_label_)
        return;

    const auto snap = xiaozhi::ChatService::Get().Snapshot();
    UpdateStatusBarTitle(snap);
    HideContentViews();

    if (snap.alert_active) {
        const std::string title   = DisplayText(snap.alert_status.empty() ? "小智提醒" : snap.alert_status);
        const std::string message = TrimForScreen(SanitizeForScreen(snap.alert_message), 72);
        RenderSystemMessage(title + (message.empty() ? "" : "\n\n" + message), false, "");
    } else {
        switch (snap.state) {
            case xiaozhi::ChatState::kCheckingConfig:
                RenderSystemMessage("正在获取小智配置...", false, "");
                break;
            case xiaozhi::ChatState::kAwaitingActivation:
                RenderSystemMessage(
                    snap.activation_message.empty() ? "请在小智控制台输入激活码" : snap.activation_message, true,
                    snap.activation_code);
                break;
            case xiaozhi::ChatState::kReadyIdle:
                lv_obj_clear_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
                lv_obj_clear_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
                break;
            case xiaozhi::ChatState::kConnecting:
                RenderSystemMessage("正在连接小智服务器...", false, "");
                break;
            case xiaozhi::ChatState::kListening:
            case xiaozhi::ChatState::kSpeaking:
                RenderChatMessages(snap);
                break;
            case xiaozhi::ChatState::kError:
                RenderSystemMessage("小智暂不可用\n\n" + TrimForScreen(snap.error, 72), false, "");
                break;
        }
    }
    if (snap.state == xiaozhi::ChatState::kListening || snap.state == xiaozhi::ChatState::kSpeaking) {
        lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(hint_label_, "上/下 调音量   长按确认 设置   双击确认 返回");
    }
    rendered_state_ = snap.state;
}

void ChatScene::HideContentViews() {
    lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
}

void ChatScene::RenderSystemMessage(const std::string& text, bool show_code, const std::string& code) {
    lv_label_set_text(system_label_, text.c_str());
    lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
    if (show_code) {
        lv_label_set_text(code_label_, code.c_str());
        lv_obj_clear_flag(code_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, -44);
        lv_obj_align(code_label_, LV_ALIGN_CENTER, 0, 18);
    } else {
        lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
    }
}

void ChatScene::RenderChatMessages(const xiaozhi::ChatSnapshot& snap) {
    lv_obj_clear_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);
    const bool        state_changed = rendered_state_ != snap.state;
    const std::string messages_key  = MessagesKey(snap);
    const bool        should_rebuild =
        state_changed || rendered_message_count_ != snap.messages.size() || rendered_messages_key_ != messages_key;
    if (state_changed && snap.state == xiaozhi::ChatState::kListening && snap.messages.empty())
        ClearChatMessages();

    if (should_rebuild) {
        ClearChatMessages();
        for (const auto& msg : snap.messages)
            AppendChatBubble(msg.role, msg.text);
        rendered_message_count_ = snap.messages.size();
        rendered_messages_key_  = messages_key;
    }

    if (chat_content_ && lv_obj_get_child_cnt(chat_content_) == 0)
        ShowEmptyChatHint();
}

void ChatScene::ClearChatMessages() {
    if (!chat_content_)
        return;
    lv_obj_clean(chat_content_);
    rendered_message_count_ = 0;
    rendered_messages_key_.clear();
}

void ChatScene::ShowEmptyChatHint() {
    if (chat_empty_label_) {
        lv_obj_clear_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
    }
}

void ChatScene::AppendChatBubble(const std::string& role, const std::string& text) {
    if (text.empty()) {
        return;
    }

    const std::string display_text = DisplayText(text);
    if (display_text.empty())
        return;

    const bool user   = role == "user";
    const bool system = role == "system";
    lv_obj_t*  row    = lv_obj_create(chat_content_);
    lv_obj_set_width(row, LV_HOR_RES);
    lv_obj_set_height(row, LV_SIZE_CONTENT);
    lv_obj_set_style_flex_grow(row, 0, 0);
    StyleTransparent(row);

    lv_obj_t* bubble = lv_obj_create(row);
    StyleBubble(bubble);
    lv_obj_t* label = lv_label_create(bubble);
    lv_obj_set_style_text_font(label, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_line_space(label, 4, 0);
    LayoutBubble(bubble, label, display_text, user);
    lv_obj_set_height(row, lv_obj_get_height(bubble) + 2);

    if (system)
        lv_obj_align(bubble, LV_ALIGN_CENTER, 0, 0);
    else if (user)
        lv_obj_align(bubble, LV_ALIGN_RIGHT_MID, -18, 0);
    else
        lv_obj_align(bubble, LV_ALIGN_LEFT_MID, 18, 0);

    lv_obj_scroll_to_view_recursive(row, LV_ANIM_OFF);
}

void ChatScene::LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text, bool user) {
    lv_label_set_text(label, text.c_str());
    lv_obj_set_width(label, LV_SIZE_CONTENT);
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
    lv_obj_update_layout(label);

    constexpr int kMaxTextW = 308;
    constexpr int kMinTextW = 36;
    const int     measured  = lv_obj_get_width(label);
    const int     text_w    = std::clamp(measured, kMinTextW, kMaxTextW);
    if (measured > kMaxTextW) {
        lv_obj_set_width(label, kMaxTextW);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    } else {
        lv_obj_set_width(label, text_w);
    }

    lv_obj_set_width(bubble, text_w + 18);
    lv_obj_set_height(bubble, LV_SIZE_CONTENT);
    lv_obj_update_layout(bubble);

    (void)user;
}

void ChatScene::UpdateStatusBarTitle(const xiaozhi::ChatSnapshot& snap) {
    status_bar_->SetCaption(StatusTitle(snap));
    if (snap.state == xiaozhi::ChatState::kReadyIdle && !snap.alert_active) {
        status_bar_->SetCaptionIcon(nullptr);
    } else {
        status_bar_->SetCaptionIcon(EmotionIcon(snap.emotion, snap.state));
    }
}
