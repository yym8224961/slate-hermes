     1|#include "scenes/hermes/hermes_scene.h"
     2|
     3|#include <esp_log.h>
     4|
     5|#include <algorithm>
     6|#include <cstdio>
     7|#include <cstring>
     8|
     9|#include "drivers/display/epd_ssd1683.h"
    10|#include "events/event_bus.h"
    11|#include "events/ui_event_log.h"
    12|#include "hermes/hermes_service.h"
    13|#include "scenes/core/scene_stack.h"
    14|#include "scenes/settings/settings_scene.h"
    15|#include "ui/theme.h"
    16|#include "utils/utf8_utils.h"
    17|
    18|namespace {
    19|constexpr char kTag[]                = "hermes_scene";
    20|constexpr int  kStandbyBottomReserve = 46;
    21|
    22|int CenterY(int y) { return y - (LV_VER_RES / 2); }
    23|int StandbyCenterY() {
    24|    return theme::kStatusBarHeight +
    25|           (LV_VER_RES - theme::kStatusBarHeight - kStandbyBottomReserve) / 2;
    26|}
    27|
    28|std::string DisplayText(const std::string& text) {
    29|    return util::TrimForScreen(util::SanitizeForScreen(text), 120);
    30|}
    31|
    32|std::string MsgKey(const hermes::HermesSnapshot& snap) {
    33|    std::string key;
    34|    for (const auto& msg : snap.messages) {
    35|        key += msg.role;
    36|        key.push_back('\x1F');
    37|        key += util::SanitizeForScreen(msg.text);
    38|        key.push_back('\x1E');
    39|    }
    40|    return key;
    41|}
    42|
    43|void StyleTransparent(lv_obj_t* obj) {
    44|    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    45|    lv_obj_set_style_border_width(obj, 0, 0);
    46|    lv_obj_set_style_pad_all(obj, 0, 0);
    47|    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
    48|}
    49|
    50|void StyleBubble(lv_obj_t* bubble) {
    51|    lv_obj_set_style_bg_opa(bubble, LV_OPA_TRANSP, 0);
    52|    lv_obj_set_style_border_width(bubble, 1, 0);
    53|    lv_obj_set_style_border_color(bubble, lv_color_black(), 0);
    54|    lv_obj_set_style_radius(bubble, 8, 0);
    55|    lv_obj_set_style_pad_left(bubble, 8, 0);
    56|    lv_obj_set_style_pad_right(bubble, 8, 0);
    57|    lv_obj_set_style_pad_top(bubble, 6, 0);
    58|    lv_obj_set_style_pad_bottom(bubble, 6, 0);
    59|    lv_obj_clear_flag(bubble, LV_OBJ_FLAG_SCROLLABLE);
    60|}
    61|}  // namespace
    62|
    63|hermes::HermesService* HermesScene::Service(SceneContext& ctx) {
    64|    if (!service_) {
    65|        service_ = &hermes::HermesService::Get();
    66|    }
    67|    return service_;
    68|}
    69|
    70|void HermesScene::EnsureServiceStarted(SceneContext& ctx) {
    71|    if (service_entered_) return;
    72|
    73|    auto* svc = Service(ctx);
    74|    if (!svc->IsStarted()) {
    75|        svc->Start(ctx.audio);
    76|    }
    77|    svc->EnterMode();
    78|    service_entered_ = true;
    79|}
    80|
    81|void HermesScene::OnEnter(SceneContext& ctx) {
    82|    ESP_LOGD(kTag, "enter");
    83|
    84|    if (!ctx.epd->Lock(2000)) {
    85|        ESP_LOGW(kTag, "enter failed: epd lock timeout");
    86|        EnsureServiceStarted(ctx);
    87|        return;
    88|    }
    89|
    90|    CreateLayout();
    91|    RefreshStatusBarFromSensors(ctx, *status_bar_);
    92|    EnsureServiceStarted(ctx);
    93|    RenderContent();
    94|
    95|    lv_refr_now(NULL);
    96|    ctx.epd->Unlock();
    97|    ctx.epd->RequestUrgentFullRefresh();
    98|    ESP_LOGD(kTag, "enter done");
    99|}
   100|
   101|void HermesScene::OnExit(SceneContext& ctx) {
   102|    ESP_LOGD(kTag, "exit");
   103|    DestroyRoot(ctx, root_, [this]() {
   104|        status_bar_.reset();
   105|        standby_icon_label_ = nullptr;
   106|        standby_body_label_ = nullptr;
   107|        system_label_       = nullptr;
   108|        chat_area_          = nullptr;
   109|        chat_content_       = nullptr;
   110|        chat_empty_label_   = nullptr;
   111|        hint_label_         = nullptr;
   112|        rendered_msg_count_ = 0;
   113|        rendered_msg_key_.clear();
   114|    });
   115|    if (service_entered_) {
   116|        if (auto* svc = Service(ctx))
   117|            svc->LeaveMode();
   118|        service_entered_ = false;
   119|    }
   120|}
   121|
   122|void HermesScene::CreateLayout() {
   123|    root_ = CreateFullscreenRoot();
   124|
   125|    status_bar_ = std::make_unique<StatusBar>(root_);
   126|    status_bar_->SetCaption("Hermes");
   127|
   128|    // Standby icon
   129|    standby_icon_label_ = lv_label_create(root_);
   130|    lv_obj_set_style_text_font(standby_icon_label_, &font_awesome_30_1, 0);
   131|    lv_obj_set_style_text_color(standby_icon_label_, lv_color_black(), 0);
   132|    lv_label_set_text(standby_icon_label_, FONT_AWESOME_MICROCHIP_AI);
   133|    lv_obj_align(standby_icon_label_, LV_ALIGN_CENTER, 0, CenterY(StandbyCenterY() - 26));
   134|
   135|    // Standby text
   136|    standby_body_label_ = lv_label_create(root_);
   137|    lv_obj_set_style_text_font(standby_body_label_, &Zfull_16, 0);
   138|    lv_obj_set_style_text_color(standby_body_label_, lv_color_black(), 0);
   139|    lv_obj_set_style_text_align(standby_body_label_, LV_TEXT_ALIGN_CENTER, 0);
   140|    lv_label_set_text(standby_body_label_, "按确认开始说话");
   141|    lv_obj_set_width(standby_body_label_, LV_HOR_RES - 48);
   142|    lv_obj_align(standby_body_label_, LV_ALIGN_CENTER, 0, CenterY(StandbyCenterY() + 26));
   143|
   144|    // System message
   145|    system_label_ = lv_label_create(root_);
   146|    lv_obj_set_style_text_font(system_label_, &Zfull_16, 0);
   147|    lv_obj_set_style_text_color(system_label_, lv_color_black(), 0);
   148|    lv_obj_set_style_text_align(system_label_, LV_TEXT_ALIGN_CENTER, 0);
   149|    lv_obj_set_style_text_line_space(system_label_, 6, 0);
   150|    lv_label_set_long_mode(system_label_, LV_LABEL_LONG_WRAP);
   151|    lv_obj_set_width(system_label_, LV_HOR_RES - 40);
   152|
   153|    // Chat area
   154|    chat_area_ = lv_obj_create(root_);
   155|    lv_obj_set_size(chat_area_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
   156|    lv_obj_set_pos(chat_area_, 0, theme::kStatusBarHeight);
   157|    StyleTransparent(chat_area_);
   158|
   159|    chat_content_ = lv_obj_create(chat_area_);
   160|    lv_obj_set_size(chat_content_, LV_HOR_RES, LV_VER_RES - theme::kStatusBarHeight);
   161|    lv_obj_set_pos(chat_content_, 0, 0);
   162|    lv_obj_set_style_bg_opa(chat_content_, LV_OPA_TRANSP, 0);
   163|    lv_obj_set_style_border_width(chat_content_, 0, 0);
   164|    lv_obj_set_style_pad_left(chat_content_, 0, 0);
   165|    lv_obj_set_style_pad_right(chat_content_, 0, 0);
   166|    lv_obj_set_style_pad_top(chat_content_, 14, 0);
   167|    lv_obj_set_style_pad_bottom(chat_content_, 14, 0);
   168|    lv_obj_set_style_pad_row(chat_content_, 8, 0);
   169|    lv_obj_set_scroll_dir(chat_content_, LV_DIR_VER);
   170|    lv_obj_set_scrollbar_mode(chat_content_, LV_SCROLLBAR_MODE_OFF);
   171|    lv_obj_set_flex_flow(chat_content_, LV_FLEX_FLOW_COLUMN);
   172|    lv_obj_set_flex_align(chat_content_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
   173|
   174|    chat_empty_label_ = lv_label_create(chat_area_);
   175|    lv_obj_set_style_text_font(chat_empty_label_, &Zfull_16, 0);
   176|    lv_obj_set_style_text_color(chat_empty_label_, lv_color_black(), 0);
   177|    lv_obj_set_style_text_align(chat_empty_label_, LV_TEXT_ALIGN_CENTER, 0);
   178|    lv_label_set_text(chat_empty_label_, "...");
   179|    lv_obj_set_width(chat_empty_label_, LV_HOR_RES - 48);
   180|    lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
   181|    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
   182|
   183|    // Hint
   184|    hint_label_ = lv_label_create(root_);
   185|    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
   186|    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
   187|    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
   188|    lv_label_set_long_mode(hint_label_, LV_LABEL_LONG_WRAP);
   189|    lv_obj_set_width(hint_label_, LV_HOR_RES - 16);
   190|    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -10);
   191|}
   192|
   193|void HermesScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
   194|    if (!root_) return;
   195|
   196|    switch (e.kind) {
   197|        case UiEventKind::kButtonShort:
   198|            if (e.u.button.btn == ButtonId::kEnter) {
   199|                if (auto* svc = Service(ctx))
   200|                    svc->ToggleChat();
   201|                SyncAndRefresh(ctx);
   202|            } else if (e.u.button.btn == ButtonId::kUp) {
   203|                if (auto* svc = Service(ctx))
   204|                    svc->AdjustVolume(+1);
   205|                SyncAndRefresh(ctx);
   206|            } else if (e.u.button.btn == ButtonId::kDown) {
   207|                if (auto* svc = Service(ctx))
   208|                    svc->AdjustVolume(-1);
   209|                SyncAndRefresh(ctx);
   210|            }
   211|            break;
   212|
   213|        case UiEventKind::kButtonDouble:
   214|            if (e.u.button.btn == ButtonId::kEnter) {
   215|                ESP_LOGD(kTag, "double enter: pop");
   216|                if (auto* svc = Service(ctx))
   217|                    svc->LeaveMode();
   218|                ctx.stack->RequestPop();
   219|            }
   220|            break;
   221|
   222|        case UiEventKind::kButtonLong:
   223|            if (e.u.button.btn == ButtonId::kEnter) {
   224|                ESP_LOGD(kTag, "long enter: push settings");
   225|                ctx.stack->RequestPush(std::make_unique<SettingsScene>());
   226|            }
   227|            break;
   228|
   229|        case UiEventKind::kHermesChanged:
   230|            SyncAndRefresh(ctx);
   231|            break;
   232|
   233|        case UiEventKind::kChargeChanged:
   234|        case UiEventKind::kBatteryUpdated:
   235|        case UiEventKind::kWifiStateChanged:
   236|        case UiEventKind::kMinuteTick:
   237|            if (root_) {
   238|                SyncRender(ctx, [this, &ctx]() {
   239|                    if (status_bar_)
   240|                        RefreshStatusBarFromSensors(ctx, *status_bar_);
   241|                    RenderContent();
   242|                });
   243|            }
   244|            break;
   245|
   246|        default:
   247|            break;
   248|    }
   249|}
   250|
   251|void HermesScene::SyncAndRefresh(SceneContext& ctx) {
   252|    if (!root_) return;
   253|    SyncRender(ctx, [this]() { RenderContent(); });
   254|}
   255|
   256|void HermesScene::RenderContent() {
   257|    if (!root_ || !status_bar_ || !system_label_ || !hint_label_) return;
   258|    if (!service_) return;
   259|
   260|    const auto snap = service_->Snapshot();
   261|    UpdateStatusBarTitle(snap);
   262|    HideContentViews();
   263|
   264|    switch (snap.state) {
   265|        case hermes::HermesState::kIdle: {
   266|            lv_obj_clear_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
   267|            lv_obj_clear_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
   268|
   269|            // Show recent messages if any
   270|            if (!snap.messages.empty()) {
   271|                lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
   272|                lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
   273|                RenderMessages(snap);
   274|            }
   275|
   276|            lv_label_set_text(hint_label_, "确认 开始说话   上/下 调音量   双击 返回");
   277|            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   278|            break;
   279|        }
   280|        case hermes::HermesState::kRecording: {
   281|            char buf[64];
   282|            snprintf(buf, sizeof(buf), "正在听... %d秒", snap.record_sec);
   283|            lv_label_set_text(system_label_, buf);
   284|            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   285|            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
   286|            lv_label_set_text(hint_label_, "确认 说完发送   上/下 调音量");
   287|            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   288|            break;
   289|        }
   290|        case hermes::HermesState::kSending:
   291|            lv_label_set_text(system_label_, "发送中...");
   292|            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   293|            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
   294|            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   295|            break;
   296|        case hermes::HermesState::kThinking:
   297|            lv_label_set_text(system_label_, "Hermes正在思考...");
   298|            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   299|            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
   300|            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   301|            break;
   302|        case hermes::HermesState::kSpeaking:
   303|            if (!snap.messages.empty()) {
   304|                RenderMessages(snap);
   305|            } else {
   306|                // Show status text if no messages yet
   307|                lv_label_set_text(system_label_, DisplayText(snap.status).c_str());
   308|                lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   309|                lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
   310|            }
   311|            lv_obj_add_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   312|            break;
   313|        case hermes::HermesState::kError:
   314|            lv_label_set_text(system_label_, snap.error.empty() ? "出错了" : snap.error.c_str());
   315|            lv_obj_clear_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   316|            lv_obj_align(system_label_, LV_ALIGN_CENTER, 0, 0);
   317|            lv_label_set_text(hint_label_, "确认 重试   双击 返回");
   318|            lv_obj_clear_flag(hint_label_, LV_OBJ_FLAG_HIDDEN);
   319|            break;
   320|    }
   321|}
   322|
   323|void HermesScene::HideContentViews() {
   324|    lv_obj_add_flag(standby_icon_label_, LV_OBJ_FLAG_HIDDEN);
   325|    lv_obj_add_flag(standby_body_label_, LV_OBJ_FLAG_HIDDEN);
   326|    lv_obj_add_flag(system_label_, LV_OBJ_FLAG_HIDDEN);
   327|    lv_obj_add_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);
   328|    lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
   329|}
   330|
   331|void HermesScene::RenderMessages(const hermes::HermesSnapshot& snap) {
   332|    lv_obj_clear_flag(chat_area_, LV_OBJ_FLAG_HIDDEN);
   333|
   334|    const std::string mk = MsgKey(snap);
   335|    const bool changed = rendered_state_ != static_cast<int>(snap.state) ||
   336|                         rendered_msg_count_ != snap.messages.size() ||
   337|                         rendered_msg_key_ != mk;
   338|
   339|    if (changed) {
   340|        ClearMessages();
   341|        for (const auto& msg : snap.messages)
   342|            AppendBubble(msg.role, msg.text);
   343|        rendered_msg_count_ = snap.messages.size();
   344|        rendered_msg_key_   = mk;
   345|    }
   346|
   347|    if (chat_content_ && lv_obj_get_child_cnt(chat_content_) == 0) {
   348|        lv_obj_clear_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
   349|        lv_obj_align(chat_empty_label_, LV_ALIGN_CENTER, 0, 0);
   350|    } else {
   351|        lv_obj_add_flag(chat_empty_label_, LV_OBJ_FLAG_HIDDEN);
   352|    }
   353|
   354|    rendered_state_ = static_cast<int>(snap.state);
   355|}
   356|
   357|void HermesScene::ClearMessages() {
   358|    if (!chat_content_) return;
   359|    lv_obj_clean(chat_content_);
   360|    rendered_msg_count_ = 0;
   361|    rendered_msg_key_.clear();
   362|}
   363|
   364|void HermesScene::AppendBubble(const std::string& role, const std::string& text) {
   365|    if (text.empty()) return;
   366|
   367|    const std::string display = DisplayText(text);
   368|    if (display.empty()) return;
   369|
   370|    const bool is_user = role == "user";
   371|
   372|    lv_obj_t* row = lv_obj_create(chat_content_);
   373|    lv_obj_set_width(row, LV_HOR_RES);
   374|    lv_obj_set_height(row, LV_SIZE_CONTENT);
   375|    lv_obj_set_style_flex_grow(row, 0, 0);
   376|    StyleTransparent(row);
   377|
   378|    lv_obj_t* bubble = lv_obj_create(row);
   379|    StyleBubble(bubble);
   380|    lv_obj_t* label = lv_label_create(bubble);
   381|    lv_obj_set_style_text_font(label, &Zfull_16, 0);
   382|    lv_obj_set_style_text_color(label, lv_color_black(), 0);
   383|    lv_obj_set_style_text_line_space(label, 4, 0);
   384|    LayoutBubble(bubble, label, display);
   385|    lv_obj_set_height(row, lv_obj_get_height(bubble) + 2);
   386|
   387|    if (is_user)
   388|        lv_obj_align(bubble, LV_ALIGN_RIGHT_MID, -18, 0);
   389|    else
   390|        lv_obj_align(bubble, LV_ALIGN_LEFT_MID, 18, 0);
   391|
   392|    lv_obj_scroll_to_view_recursive(row, LV_ANIM_OFF);
   393|}
   394|
   395|void HermesScene::LayoutBubble(lv_obj_t* bubble, lv_obj_t* label, const std::string& text) {
   396|    lv_label_set_text(label, text.c_str());
   397|    lv_obj_set_width(label, LV_SIZE_CONTENT);
   398|    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
   399|    lv_obj_update_layout(label);
   400|
   401|    constexpr int kMaxW = 308;
   402|    constexpr int kMinW = 36;
   403|    const int measured = lv_obj_get_width(label);
   404|    const int text_w   = std::clamp(measured, kMinW, kMaxW);
   405|    if (measured > kMaxW) {
   406|        lv_obj_set_width(label, kMaxW);
   407|        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
   408|    } else {
   409|        lv_obj_set_width(label, text_w);
   410|    }
   411|
   412|    lv_obj_set_width(bubble, text_w + 18);
   413|    lv_obj_set_height(bubble, LV_SIZE_CONTENT);
   414|    lv_obj_update_layout(bubble);
   415|}
   416|
   417|void HermesScene::UpdateStatusBarTitle(const hermes::HermesSnapshot& snap) {
   418|    switch (snap.state) {
   419|        case hermes::HermesState::kIdle:      status_bar_->SetCaption("Hermes"); break;
   420|        case hermes::HermesState::kRecording:  status_bar_->SetCaption("Hermes - 录音"); break;
   421|        case hermes::HermesState::kSending:    status_bar_->SetCaption("Hermes - 发送"); break;
   422|        case hermes::HermesState::kThinking:   status_bar_->SetCaption("Hermes - 思考"); break;
   423|        case hermes::HermesState::kSpeaking:   status_bar_->SetCaption("Hermes - 回复"); break;
   424|        case hermes::HermesState::kError:      status_bar_->SetCaption("Hermes - !"); break;
   425|    }
   426|    status_bar_->SetCaptionIcon(nullptr);
   427|}
   428|