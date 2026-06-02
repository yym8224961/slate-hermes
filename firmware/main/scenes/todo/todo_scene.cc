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
constexpr const char* kCheckMark  = "\xE2\x9C\x93";  // ✓ UTF-8
constexpr const char* kEmptyBox   = "\xE2\x96\xA1";  // □ UTF-8

// 简单的 HTTP GET，不需要 auth（capability URL 模式）
std::string HttpGet(const std::string& url) {
    esp_http_client_config_t cfg = {};
    cfg.url            = url.c_str();
    cfg.timeout_ms     = kHttpTimeoutMs;
    cfg.buffer_size    = 2048;
    cfg.disable_auto_redirect = true;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        ESP_LOGE(kTag, "http client init failed");
        return "";
    }

    esp_http_client_set_method(client, HTTP_METHOD_GET);
    esp_err_t err = esp_http_client_perform(client);
    if (err != ESP_OK) {
        ESP_LOGE(kTag, "http GET failed err=%s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return "";
    }

    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGW(kTag, "http GET status=%d", status);
        esp_http_client_cleanup(client);
        return "";
    }

    // Read body
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

// POST data to capability URL
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

    bool ok = (err == ESP_OK && status >= 200 && status < 300);
    if (!ok) {
        ESP_LOGW(kTag, "http POST failed err=%s status=%d", esp_err_to_name(err), status);
    }
    return ok;
}

}  // namespace

TodoScene::TodoScene(SceneContext& ctx, std::string content_id)
    : content_id_(std::move(content_id)) {
}

TodoScene::~TodoScene() {
}

void TodoScene::OnEnter(SceneContext& ctx) {
    ESP_LOGI(kTag, "enter cid=%s", content_id_.c_str());

    if (!ctx.epd->Lock(3000)) {
        ESP_LOGW(kTag, "enter failed reason=epd_lock_timeout");
        return;
    }

    // 从 Slate 后端拉取最新待办数据
    if (!FetchTodoData()) {
        ESP_LOGW(kTag, "fetch failed, using empty list");
        items_.clear();
    }

    CreateLayout();
    RenderList();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentFullRefresh();
    ESP_LOGI(kTag, "enter done items=%d", static_cast<int>(items_.size()));
}

void TodoScene::OnExit(SceneContext& ctx) {
    ESP_LOGI(kTag, "exit dirty=%d", dirty_ ? 1 : 0);

    if (dirty_) {
        // 回写状态到 Slate 后端
        PushTodoState();
    }

    DestroyRoot(ctx, root_, [this]() {
        header_label_ = nullptr;
        hint_label_   = nullptr;
        DestroyItemControls();
    });
}

void TodoScene::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_) return;

    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        // 长按确认 = 退出
        ESP_LOGI(kTag, "exit via long press");
        ctx.stack->RequestPop();
        return;
    }

    if (e.kind == UiEventKind::kButtonShort) {
        switch (e.u.button.btn) {
            case ButtonId::kUp:
                MoveCursor(-1);
                break;
            case ButtonId::kDown:
                MoveCursor(1);
                break;
            case ButtonId::kEnter:
                ToggleCurrent();
                break;
            default:
                break;
        }
    }
}

// ── 数据获取 ───────────────────────────────────────────────

bool TodoScene::FetchTodoData() {
    // 从 NVS 读取服务器地址
    cred::Credentials creds;
    if (!cred::Load(creds) || creds.server_url.empty()) {
        ESP_LOGW(kTag, "no server url in credentials");
        return false;
    }

    char url_buf[256];
    std::snprintf(url_buf, sizeof(url_buf),
                  "%s/api/v1/contents/%s/data",
                  creds.server_url.c_str(), content_id_.c_str());

    std::string body = HttpGet(std::string(url_buf));
    if (body.empty()) {
        ESP_LOGW(kTag, "fetch returned empty body");
        return false;
    }

    // 解析 JSON
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
    return true;
}

bool TodoScene::PushTodoState() {
    cred::Credentials creds;
    if (!cred::Load(creds) || creds.server_url.empty()) {
        return false;
    }

    // 构建更新的 JSON
    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 1);

    cJSON* data = cJSON_CreateObject();
    cJSON* todos_arr = cJSON_CreateArray();
    for (const auto& item : items_) {
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

    if (ok) {
        dirty_ = false;
        ESP_LOGI(kTag, "state pushed ok items=%d", static_cast<int>(items_.size()));
    }
    return ok;
}

// ── UI 渲染 ────────────────────────────────────────────────

void TodoScene::CreateLayout() {
    root_ = CreateFullscreenRoot();

    // 标题
    header_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(header_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(header_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(header_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(header_label_, LV_HOR_RES - 32);
    lv_obj_align(header_label_, LV_ALIGN_TOP_MID, 0, 28);

    // 底部提示
    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_label_, "\xe2\x86\x91\xe2\x86\x93 选择  确认 \xe2\x9c\x93  长按退出");
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -16);
}

void TodoScene::RenderList() {
    char buf[128];
    int  active_count = 0;
    for (const auto& item : items_) {
        if (!item.done) active_count++;
    }
    std::snprintf(buf, sizeof(buf), "待办事项 (%d/%d)",
                  active_count, static_cast<int>(items_.size()));
    lv_label_set_text(header_label_, buf);

    DestroyItemControls();

    int count = std::min(static_cast<int>(items_.size()), kMaxVisibleItems);
    item_ctrls_.reserve(count);

    for (int i = 0; i < count; i++) {
        const auto& item = items_[i];
        bool is_cursor   = (i == cursor_);
        bool is_done     = item.done;

        lv_obj_t* label = lv_label_create(root_);
        lv_obj_set_style_text_font(label, &Zfull_16, 0);
        lv_obj_set_style_text_color(label, lv_color_black(), 0);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(label, LV_HOR_RES - 48);

        // 格式: "> [✓/□] 待办文本"
        const char* cursor_mark = is_cursor ? ">" : " ";
        const char* check_mark  = is_done ? kCheckMark : kEmptyBox;
        std::snprintf(buf, sizeof(buf), "%s %s %s",
                      cursor_mark, check_mark, item.text.c_str());
        lv_label_set_text(label, buf);

        int y = kItemYStart + i * kItemHeight;
        lv_obj_set_pos(label, 16, y);

        ItemControl ctrl;
        ctrl.label = label;
        item_ctrls_.push_back(ctrl);
    }
}

void TodoScene::MoveCursor(int delta) {
    if (items_.empty()) return;
    int new_cursor = cursor_ + delta;
    if (new_cursor < 0) new_cursor = static_cast<int>(items_.size()) - 1;
    if (new_cursor >= static_cast<int>(items_.size())) new_cursor = 0;
    if (new_cursor == cursor_) return;

    cursor_ = new_cursor;
    RenderList();
    // 刷新屏幕
    lv_refr_now(NULL);
    if (auto* epd = Board::Get().epd()) {
        epd->RequestUrgentFullRefresh();
    }
}

void TodoScene::ToggleCurrent() {
    if (items_.empty() || cursor_ >= static_cast<int>(items_.size())) return;
    items_[cursor_].done = !items_[cursor_].done;
    dirty_ = true;
    RenderList();
    lv_refr_now(NULL);
    if (auto* epd = Board::Get().epd()) {
        epd->RequestUrgentFullRefresh();
    }
}

void TodoScene::DestroyItemControls() {
    for (auto& ctrl : item_ctrls_) {
        if (ctrl.label) {
            lv_obj_del(ctrl.label);
            ctrl.label = nullptr;
        }
    }
    item_ctrls_.clear();
}
