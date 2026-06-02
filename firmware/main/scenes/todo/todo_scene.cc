#include "scenes/todo/todo_scene.h"

#include <esp_http_client.h>
#include <esp_log.h>

#include <cJSON.h>
#include <cstdio>
#include <cstring>
#include <memory>

#include "bsp/board.h"
#include "drivers/display/epd_ssd1683.h"
#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "network/cred_store.h"
#include "scenes/core/scene_stack.h"
#include "ui/theme.h"

namespace {
constexpr char kTag[]            = "todo";
constexpr int  kHttpTimeoutMs    = 8000;
constexpr int  kMaxBodySize      = 4096;
constexpr char kContentTypeJson[] = "application/json";
constexpr const char* kCheckMark  = "\xE2\x9C\x93";  // ✓
constexpr const char* kEmptyBox   = "\xE2\x96\xA1";  // □
constexpr const char* kNewMark    = "+";

std::string HttpGet(const std::string& url) {
    esp_http_client_config_t cfg = {};
    cfg.url            = url.c_str();
    cfg.timeout_ms     = kHttpTimeoutMs;
    cfg.buffer_size    = 2048;
    cfg.disable_auto_redirect = true;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return "";

    esp_http_client_set_method(client, HTTP_METHOD_GET);
    esp_err_t err = esp_http_client_perform(client);
    if (err != ESP_OK) { esp_http_client_cleanup(client); return ""; }

    int status = esp_http_client_get_status_code(client);
    if (status != 200) { esp_http_client_cleanup(client); return ""; }

    std::string body;
    body.reserve(kMaxBodySize);
    char buf[512];
    int  read_len = 0;
    while ((read_len = esp_http_client_read(client, buf, sizeof(buf) - 1)) > 0) {
        buf[read_len] = '\0';
        body += buf;
        if (body.size() > kMaxBodySize) break;
    }
    esp_http_client_cleanup(client);
    return body;
}

bool HttpPost(const std::string& url, const std::string& json_body) {
    esp_http_client_config_t cfg = {};
    cfg.url            = url.c_str();
    cfg.timeout_ms     = kHttpTimeoutMs;
    cfg.disable_auto_redirect = true;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return false;

    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", kContentTypeJson);
    esp_http_client_set_post_field(client, json_body.c_str(), json_body.size());

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    return (err == ESP_OK && status >= 200 && status < 300);
}

void RefreshEpd() {
    lv_refr_now(NULL);
    if (auto* epd = Board::Get().epd())
        epd->RequestUrgentFullRefresh();
}

}  // namespace

TodoScene::TodoScene(SceneContext& ctx, std::string content_id)
    : content_id_(std::move(content_id)) {
    offline_ = (content_id_ == "todo_default" || content_id_.empty());
}

TodoScene::~TodoScene() {}

void TodoScene::OnEnter(SceneContext& ctx) {
    ESP_LOGI(kTag, "enter cid=%s offline=%d", content_id_.c_str(), offline_ ? 1 : 0);

    if (!ctx.epd->Lock(3000)) {
        ESP_LOGW(kTag, "enter failed: epd lock timeout");
        return;
    }

    if (!offline_) {
        if (!FetchTodoData()) {
            ESP_LOGW(kTag, "fetch failed, using empty list");
            items_.clear();
        }
    } else {
        // Local mode: start with empty list + "新建" entry
        if (items_.empty()) {
            TodoItem ni;
            ni.is_new = true;
            ni.text   = "新建提醒...";
            items_.push_back(ni);
        }
    }

    mode_  = Mode::kList;
    CreateLayout();
    RenderList();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
    ESP_LOGI(kTag, "enter done items=%d", static_cast<int>(items_.size()));
}

void TodoScene::OnExit(SceneContext& ctx) {
    ESP_LOGI(kTag, "exit dirty=%d", dirty_ ? 1 : 0);
    if (dirty_ && !offline_) {
        PushTodoState();
    }
    DestroyRoot(ctx, root_, [this]() {
        header_label_ = nullptr;
        hint_label_   = nullptr;
        picker_label_ = nullptr;
        DestroyItemControls();
    });
}

void TodoScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_) return;

    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        if (mode_ == Mode::kPicker) {
            // Exit picker without selecting
            mode_ = Mode::kList;
            RenderList();
            RefreshEpd();
        } else {
            ESP_LOGI(kTag, "exit via long press");
            ctx.stack->RequestPop();
        }
        return;
    }

    if (e.kind == UiEventKind::kButtonShort) {
        switch (e.u.button.btn) {
            case ButtonId::kUp:
                if (mode_ == Mode::kPicker) {
                    if (preset_idx_ > 0) { preset_idx_--; RenderPresetPicker(); RefreshEpd(); }
                } else {
                    MoveCursor(-1);
                }
                break;
            case ButtonId::kDown:
                if (mode_ == Mode::kPicker) {
                    if (preset_idx_ < (int)kTodoPresets.size() - 1) { preset_idx_++; RenderPresetPicker(); RefreshEpd(); }
                } else {
                    MoveCursor(1);
                }
                break;
            case ButtonId::kEnter:
                if (mode_ == Mode::kPicker) {
                    SelectPreset(preset_idx_);
                    mode_ = Mode::kList;
                    RenderList();
                    RefreshEpd();
                } else {
                    if (cursor_ >= 0 && cursor_ < (int)items_.size() && items_[cursor_].is_new) {
                        // Enter preset picker
                        mode_ = Mode::kPicker;
                        preset_idx_ = 0;
                        RenderPresetPicker();
                        RefreshEpd();
                    } else {
                        ToggleCurrent();
                    }
                }
                break;
            default:
                break;
        }
    }
}

// ── Data ────────────────────────────────────────────────────────

bool TodoScene::FetchTodoData() {
    cred::Credentials creds;
    if (!cred::Load(creds) || creds.server_url.empty()) return false;

    char url_buf[256];
    std::snprintf(url_buf, sizeof(url_buf),
                  "%s/api/v1/contents/%s/data",
                  creds.server_url.c_str(), content_id_.c_str());

    std::string body = HttpGet(std::string(url_buf));
    if (body.empty()) return false;

    cJSON* root = cJSON_Parse(body.c_str());
    if (!root) return false;

    cJSON* todos_arr = cJSON_GetObjectItem(root, "todos");
    if (todos_arr && cJSON_IsArray(todos_arr)) {
        items_.clear();
        int count = cJSON_GetArraySize(todos_arr);
        for (int i = 0; i < count && i < kMaxVisibleItems; i++) {
            cJSON* item = cJSON_GetArrayItem(todos_arr, i);
            if (!item) continue;
            cJSON* text = cJSON_GetObjectItem(item, "text");
            cJSON* done = cJSON_GetObjectItem(item, "done");
            TodoItem t;
            t.text = text && cJSON_IsString(text) ? text->valuestring : "";
            t.done = done && cJSON_IsBool(done) ? cJSON_IsTrue(done) : false;
            items_.push_back(std::move(t));
        }
    }
    cJSON_Delete(root);

    // Always add "新建" at the end
    TodoItem ni;
    ni.is_new = true;
    ni.text   = "新建提醒...";
    items_.push_back(ni);

    return true;
}

bool TodoScene::PushTodoState() {
    cred::Credentials creds;
    if (!cred::Load(creds) || creds.server_url.empty()) return false;

    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 1);
    cJSON* data = cJSON_CreateObject();
    cJSON* todos_arr = cJSON_CreateArray();
    for (const auto& item : items_) {
        if (item.is_new) continue;  // skip the placeholder
        cJSON* obj = cJSON_CreateObject();
        cJSON_AddStringToObject(obj, "text", item.text.c_str());
        cJSON_AddBoolToObject(obj, "done", item.done);
        cJSON_AddItemToArray(todos_arr, obj);
    }
    cJSON_AddItemToObject(data, "todos", todos_arr);
    cJSON_AddItemToObject(root, "data", data);

    char* json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json_str) return false;

    char url_buf[256];
    std::snprintf(url_buf, sizeof(url_buf),
                  "%s/api/v1/contents/%s/data",
                  creds.server_url.c_str(), content_id_.c_str());

    bool ok = HttpPost(std::string(url_buf), std::string(json_str));
    cJSON_free(json_str);
    if (ok) { dirty_ = false; }
    return ok;
}

void TodoScene::AddItem(const std::string& text) {
    // Find the "新建" placeholder
    int insert_pos = items_.size();
    for (int i = 0; i < (int)items_.size(); i++) {
        if (items_[i].is_new) { insert_pos = i; break; }
    }
    TodoItem new_item;
    new_item.text = text;
    items_.insert(items_.begin() + insert_pos, new_item);
    dirty_ = true;
    cursor_ = insert_pos;
    ESP_LOGI(kTag, "added item: %s at pos %d", text.c_str(), insert_pos);
}

void TodoScene::SelectPreset(int index) {
    if (index >= 0 && index < (int)kTodoPresets.size()) {
        AddItem(kTodoPresets[index]);
    }
}

// ── UI ──────────────────────────────────────────────────────────

void TodoScene::CreateLayout() {
    root_ = CreateFullscreenRoot();

    header_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(header_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(header_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(header_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(header_label_, LV_HOR_RES - 32);
    lv_obj_align(header_label_, LV_ALIGN_TOP_MID, 0, 24);

    picker_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(picker_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(picker_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(picker_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_add_flag(picker_label_, LV_OBJ_FLAG_HIDDEN);

    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_label_, "↑↓ 选择  确认 ✓  长按退出");
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -16);
}

void TodoScene::RenderList() {
    char buf[128];
    int active = 0, total = 0;
    for (const auto& item : items_) {
        if (!item.is_new) {
            total++;
            if (!item.done) active++;
        }
    }
    std::snprintf(buf, sizeof(buf), "待办事项 (%d/%d)", active, total);
    lv_label_set_text(header_label_, buf);
    lv_obj_clear_flag(header_label_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(picker_label_, LV_OBJ_FLAG_HIDDEN);

    DestroyItemControls();
    lv_label_set_text(hint_label_, "↑↓ 选择  确认 ✓/新建  长按退出");

    int count = std::min((int)items_.size(), kMaxVisibleItems);
    item_ctrls_.reserve(count);

    for (int i = 0; i < count; i++) {
        const auto& item = items_[i];
        bool is_cursor = (i == cursor_);

        lv_obj_t* label = lv_label_create(root_);
        lv_obj_set_style_text_font(label, &Zfull_16, 0);
        lv_obj_set_style_text_color(label, lv_color_black(), 0);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(label, LV_HOR_RES - 48);

        if (item.is_new) {
            const char* cm = is_cursor ? ">" : " ";
            std::snprintf(buf, sizeof(buf), "%s [+ %s]", cm, item.text.c_str());
        } else {
            const char* cm = is_cursor ? ">" : " ";
            const char* ck = item.done ? kCheckMark : kEmptyBox;
            std::snprintf(buf, sizeof(buf), "%s %s %s", cm, ck, item.text.c_str());
        }
        lv_label_set_text(label, buf);
        lv_obj_set_pos(label, 16, kItemYStart + i * kItemHeight);

        ItemControl ctrl;
        ctrl.label = label;
        item_ctrls_.push_back(ctrl);
    }
}

void TodoScene::RenderPresetPicker() {
    lv_obj_add_flag(header_label_, LV_OBJ_FLAG_HIDDEN);
    DestroyItemControls();

    lv_label_set_text(picker_label_, "选择提醒类型:");
    lv_obj_align(picker_label_, LV_ALIGN_TOP_MID, 0, 24);
    lv_obj_clear_flag(picker_label_, LV_OBJ_FLAG_HIDDEN);

    lv_label_set_text(hint_label_, "↑↓ 选择  确认 确定  长按 取消");

    int count = std::min((int)kTodoPresets.size(), kMaxVisibleItems);
    picker_ctrls_.clear();
    picker_ctrls_.reserve(count);

    for (int i = 0; i < count; i++) {
        bool is_cursor = (i == preset_idx_);

        lv_obj_t* label = lv_label_create(root_);
        lv_obj_set_style_text_font(label, &Zfull_16, 0);
        lv_obj_set_style_text_color(label, lv_color_black(), 0);
        lv_obj_set_width(label, LV_HOR_RES - 48);

        char buf[128];
        const char* cm = is_cursor ? ">" : " ";
        std::snprintf(buf, sizeof(buf), "%s %s", cm, kTodoPresets[i].c_str());
        lv_label_set_text(label, buf);
        lv_obj_set_pos(label, 16, kPickerYStart + i * kItemHeight);

        ItemControl ctrl;
        ctrl.label = label;
        picker_ctrls_.push_back(ctrl);
    }
}

void TodoScene::MoveCursor(int delta) {
    if (items_.empty()) return;
    int nc = cursor_ + delta;
    if (nc < 0) nc = (int)items_.size() - 1;
    if (nc >= (int)items_.size()) nc = 0;
    if (nc == cursor_) return;
    cursor_ = nc;
    RenderList();
    RefreshEpd();
}

void TodoScene::ToggleCurrent() {
    if (items_.empty() || cursor_ >= (int)items_.size()) return;
    if (items_[cursor_].is_new) return;
    items_[cursor_].done = !items_[cursor_].done;
    dirty_ = true;
    RenderList();
    RefreshEpd();
}

void TodoScene::DestroyItemControls() {
    for (auto& ctrl : item_ctrls_) {
        if (ctrl.label) { lv_obj_del(ctrl.label); ctrl.label = nullptr; }
    }
    item_ctrls_.clear();
    for (auto& ctrl : picker_ctrls_) {
        if (ctrl.label) { lv_obj_del(ctrl.label); ctrl.label = nullptr; }
    }
    picker_ctrls_.clear();
}
