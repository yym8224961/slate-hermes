#include "api_client.h"

#include <cJSON.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_log.h>

#include <cstring>
#include <utility>

#include "protocol_keys.h"

namespace {
constexpr char kTag[] = "Api";
constexpr int  kUnauthorizedResetThreshold = 5;
}

namespace api {

static std::string s_url;
static std::string s_mac;
static std::string s_secret;
static UnauthorizedCb s_unauth_cb;
static int s_consecutive_401 = 0;

void Init(const std::string& url, const std::string& mac, const std::string& device_secret) {
    s_url    = url;
    s_mac    = mac;
    s_secret = device_secret;
}
void SetServerUrl(const std::string& url) { s_url = url; }
void SetSecret(const std::string& secret) { s_secret = secret; }
void SetUnauthorizedHandler(UnauthorizedCb cb) { s_unauth_cb = std::move(cb); }

namespace {

// 从 esp_http_client 读响应头里的 ETag。
std::string ReadEtagHeader(esp_http_client_handle_t client) {
    char* val = nullptr;
    if (esp_http_client_get_header(client, "ETag", &val) == ESP_OK && val) {
        std::string s(val);
        if (s.size() >= 2 && s.front() == '"' && s.back() == '"') {
            s = s.substr(1, s.size() - 2);
        }
        return s;
    }
    return {};
}

void LogErrorEnvelope(const std::string& path, int status, const std::vector<uint8_t>& body) {
    if (body.empty()) {
        ESP_LOGW(kTag, "%s -> HTTP %d", path.c_str(), status);
        return;
    }
    std::string text(body.begin(), body.end());
    cJSON* root = cJSON_Parse(text.c_str());
    if (!root) {
        ESP_LOGW(kTag, "%s -> HTTP %d: %.160s", path.c_str(), status, text.c_str());
        return;
    }
    auto get_str = [](cJSON* obj, const char* key) -> const char* {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, key);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    const char* klass = get_str(root, proto::kError);
    const char* msg   = get_str(root, proto::kMessage);
    const char* code  = "";
    cJSON* detail = cJSON_GetObjectItemCaseSensitive(root, proto::kDetail);
    if (cJSON_IsObject(detail)) {
        code = get_str(detail, proto::kCode);
    }
    ESP_LOGW(kTag, "%s -> HTTP %d error=%s code=%s message=%s",
             path.c_str(), status, klass, code, msg);
    cJSON_Delete(root);
}

}  // namespace

// API 路径前缀(对应 backend shared API_PREFIX = "/api/v1")。
constexpr char kApiPrefix[] = "/api/v1";

// 同步 HTTP 请求。
//   path/method/body_in - 请求(path 已带 /api/v1 前缀)
//   body_out            - 响应 body
//   status_out          - HTTP 状态码(可空)
//   if_none_match       - 非空时设 If-None-Match 头
//   etag_out            - 响应头 ETag(可空,去引号)
//   need_auth           - true:加 Authorization: Bearer s_secret。register 端点设 false。
//
// 401:仅对 need_auth=true 的请求触发 unauth_cb (注册路径无鉴权,401 没意义)。
static bool DoRequest(const std::string& path, esp_http_client_method_t method,
                      const std::string& body_in, std::vector<uint8_t>& body_out,
                      int* status_out                = nullptr,
                      const std::string& if_none_match = "",
                      std::string* etag_out          = nullptr,
                      bool need_auth                 = true) {
    if (s_url.empty()) {
        ESP_LOGW(kTag, "Server URL not set");
        return false;
    }
    std::string full = s_url;
    if (!full.empty() && full.back() == '/') full.pop_back();
    full += path;

    esp_http_client_config_t cfg = {};
    cfg.url                       = full.c_str();
    cfg.method                    = method;
    cfg.timeout_ms                = 8000;
    cfg.disable_auto_redirect     = false;
    // 挂 IDF 内置 root CA bundle:HTTPS 必备(否则 TLS 握手无 CA 校验失败)。
    // 注意调用方需要确保系统时间已对时(SNTP),否则证书 NotBefore/NotAfter 校验过不去。
    cfg.crt_bundle_attach         = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return false;

    if (need_auth) {
        if (s_secret.empty()) {
            ESP_LOGW(kTag, "%s: need_auth but secret empty", path.c_str());
            esp_http_client_cleanup(client);
            return false;
        }
        std::string bearer = "Bearer " + s_secret;
        esp_http_client_set_header(client, "Authorization", bearer.c_str());
    }
    if (!body_in.empty()) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
    }
    if (!if_none_match.empty()) {
        std::string h = "\"" + if_none_match + "\"";
        esp_http_client_set_header(client, "If-None-Match", h.c_str());
    }

    esp_err_t err = esp_http_client_open(client, body_in.size());
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Open %s failed: %s", path.c_str(), esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return false;
    }

    if (!body_in.empty()) {
        int wn = esp_http_client_write(client, body_in.c_str(), body_in.size());
        if (wn != static_cast<int>(body_in.size())) {
            ESP_LOGW(kTag, "Write %s short: %d/%u", path.c_str(), wn, (unsigned)body_in.size());
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    int status             = esp_http_client_get_status_code(client);
    if (status_out) *status_out = status;
    if (etag_out) *etag_out     = ReadEtagHeader(client);

    body_out.clear();
    if (status != 304) {
        // 防止异常响应耗尽堆内存。
        // JSON API 端点响应通常 < 64 KB；二进制资源端点（1bpp 图 15 KB、PCM 音频最大约数百 KB）
        // 也走此函数，统一限 1 MB 作为安全上界。
        constexpr size_t kMaxResponseBytes = 1u * 1024 * 1024;
        if (content_length < 0) {
            ESP_LOGW(kTag, "%s: fetch headers failed: %lld", path.c_str(), (long long)content_length);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
        if (content_length > static_cast<int64_t>(kMaxResponseBytes)) {
            ESP_LOGW(kTag, "%s: Content-Length %lld exceeds 1 MB limit",
                     path.c_str(), (long long)content_length);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
        if (content_length > 0) body_out.reserve(static_cast<size_t>(content_length));
        char buf[1024];
        while (true) {
            int n = esp_http_client_read(client, buf, sizeof(buf));
            if (n <= 0) break;
            body_out.insert(body_out.end(), buf, buf + n);
            if (body_out.size() > kMaxResponseBytes) {
                ESP_LOGW(kTag, "%s: response body exceeded 1 MB, aborting", path.c_str());
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return false;
            }
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status == 304) return true;
    if (status / 100 == 2) {
        s_consecutive_401 = 0;
        return true;
    }
    if (status == 401 && need_auth) {
        ++s_consecutive_401;
        LogErrorEnvelope(path, status, body_out);
        ESP_LOGW(kTag, "%s -> 401 count=%d/%d",
                 path.c_str(), s_consecutive_401, kUnauthorizedResetThreshold);
        if (s_consecutive_401 >= kUnauthorizedResetThreshold && s_unauth_cb) {
            s_unauth_cb();
        }
        return false;
    }
    s_consecutive_401 = 0;
    LogErrorEnvelope(path, status, body_out);
    return false;
}

static bool DoRequestJson(const std::string& path, esp_http_client_method_t method,
                          const std::string& body_in, std::string& body_out_str,
                          bool need_auth = true) {
    std::vector<uint8_t> bytes;
    bool                 ok = DoRequest(path, method, body_in, bytes, nullptr, "", nullptr, need_auth);
    body_out_str.assign(bytes.begin(), bytes.end());
    return ok;
}

// ─── 私有 helper:解析 DeviceState JSON ────────────────────────────
namespace {

bool ParseDeviceState(const std::string& json, DeviceState& out) {
    cJSON* root = cJSON_Parse(json.c_str());
    if (!root) return false;

    auto get_str = [](cJSON* obj, const char* k) -> std::string {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, k);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    auto get_int = [](cJSON* obj, const char* k, int def) -> int {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, k);
        return cJSON_IsNumber(v) ? v->valueint : def;
    };
    auto get_bool = [](cJSON* obj, const char* k, bool def) -> bool {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, k);
        if (cJSON_IsBool(v)) return cJSON_IsTrue(v);
        return def;
    };

    cJSON* dev = cJSON_GetObjectItemCaseSensitive(root, proto::kDevice);
    if (cJSON_IsObject(dev)) {
        out.device_id   = get_str(dev, proto::kId);
        out.device_name = get_str(dev, proto::kName);
        out.bound       = get_bool(dev, proto::kBound, false);
        out.pair_code   = get_str(dev, proto::kPairCode);
        out.server_time = get_str(dev, proto::kServerTime);
    }

    cJSON* group = cJSON_GetObjectItemCaseSensitive(root, proto::kGroup);
    if (cJSON_IsObject(group)) {
        out.has_group         = true;
        out.group_id          = get_str(group, proto::kId);
        out.group_name        = get_str(group, proto::kName);
        out.group_etag        = get_str(group, proto::kEtag);
        out.content_count     = get_int(group, proto::kContentCount, 0);
        out.group_sort_order  = get_int(group, proto::kSortOrder, 0);
        cJSON* pos = cJSON_GetObjectItemCaseSensitive(group, proto::kPosition);
        if (cJSON_IsObject(pos)) {
            out.position_current = get_int(pos, proto::kCurrent, 0);
            out.position_total   = get_int(pos, proto::kTotal, 0);
        }
    } else {
        out.has_group = false;
    }

    cJSON_Delete(root);
    return true;
}

}  // namespace

// ─── 设备协议端点 ────────────────────────────────────────────────
bool Register(RegisterResult& out) {
    cJSON* j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, proto::kMac, s_mac.c_str());
    char* body = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices/register";
    bool ok = DoRequestJson(path, HTTP_METHOD_POST, body, resp, /*need_auth=*/false);
    cJSON_free(body);
    if (!ok) return false;

    cJSON* root = cJSON_Parse(resp.c_str());
    if (!root) {
        ESP_LOGW(kTag, "Register: invalid json response");
        return false;
    }
    auto get_str = [&](const char* k) -> std::string {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(root, k);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    out.device_id     = get_str(proto::kDeviceId);
    out.device_secret = get_str(proto::kDeviceSecret);
    out.pair_code     = get_str(proto::kPairCode);
    cJSON* rcl        = cJSON_GetObjectItemCaseSensitive(root, proto::kReclaimed);
    out.reclaimed     = cJSON_IsTrue(rcl);
    cJSON_Delete(root);

    if (out.device_id.empty() || out.device_secret.empty() || out.pair_code.empty()) {
        ESP_LOGW(kTag, "Register: response missing required fields");
        return false;
    }
    ESP_LOGI(kTag, "Registered: id=%s pair=%s reclaimed=%d",
             out.device_id.c_str(), out.pair_code.c_str(), (int)out.reclaimed);
    return true;
}

bool Poll(const Telemetry& tel, DeviceState& out) {
    cJSON* root = cJSON_CreateObject();

    // 仅在有非默认值的字段时构造 telemetry 对象。
    bool has_telemetry =
        tel.battery_pct >= 0 || tel.rssi_dbm != 0 ||
        !tel.fw_version.empty() || tel.free_heap >= 0 ||
        !tel.fw_build_ts.empty() || !tel.current_group.empty() ||
        tel.current_content_seq >= 0;
    if (has_telemetry) {
        cJSON* t = cJSON_CreateObject();
        if (tel.battery_pct >= 0) cJSON_AddNumberToObject(t, proto::kBatteryPct, tel.battery_pct);
        if (tel.rssi_dbm != 0)    cJSON_AddNumberToObject(t, proto::kRssiDbm, tel.rssi_dbm);
        if (!tel.fw_version.empty())
            cJSON_AddStringToObject(t, proto::kFwVersion, tel.fw_version.c_str());
        if (tel.free_heap >= 0)
            cJSON_AddNumberToObject(t, proto::kFreeHeap, tel.free_heap);
        if (!tel.fw_build_ts.empty())
            cJSON_AddStringToObject(t, proto::kFwBuildTs, tel.fw_build_ts.c_str());
        if (!tel.current_group.empty())
            cJSON_AddStringToObject(t, proto::kCurrentGroup, tel.current_group.c_str());
        if (tel.current_content_seq >= 0)
            cJSON_AddNumberToObject(t, proto::kCurrentContentSeq, tel.current_content_seq);
        cJSON_AddItemToObject(root, proto::kTelemetry, t);
    }

    char* body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/me/poll";
    bool ok = DoRequestJson(path, HTTP_METHOD_POST, body, resp);
    cJSON_free(body);
    if (!ok) return false;
    return ParseDeviceState(resp, out);
}

// direction: "next" | "prev" → POST /api/v1/me/group/{direction}
bool CycleGroup(const std::string& direction, DeviceState& out) {
    if (direction != "next" && direction != "prev") return false;
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/me/group/" + direction;
    bool ok = DoRequestJson(path, HTTP_METHOD_POST, "", resp);
    if (!ok) return false;
    return ParseDeviceState(resp, out);
}

bool SelectGroup(const std::string& gid, DeviceState& out) {
    cJSON* j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, proto::kId, gid.c_str());
    char* body = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/me/group";
    bool ok = DoRequestJson(path, HTTP_METHOD_PUT, body, resp);
    cJSON_free(body);
    if (!ok) return false;
    return ParseDeviceState(resp, out);
}

bool GetManifest(const std::string& group_id, const std::string& if_none_match,
                 Manifest& out, bool& not_modified) {
    not_modified = false;
    std::string          path = std::string(kApiPrefix) + "/groups/" + group_id + "/manifest";
    std::vector<uint8_t> bytes;
    int                  status   = 0;
    std::string          etag_out;
    bool ok = DoRequest(path, HTTP_METHOD_GET, "", bytes, &status, if_none_match, &etag_out,
                        /*need_auth=*/true);
    if (!ok) return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }

    std::string  resp(bytes.begin(), bytes.end());
    cJSON* root = cJSON_Parse(resp.c_str());
    if (!root) return false;

    auto json_str = [](cJSON* obj, const char* k) -> std::string {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, k);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    auto json_int = [](cJSON* obj, const char* k, int def) -> int {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, k);
        return cJSON_IsNumber(v) ? v->valueint : def;
    };
    // 协议 v3：group 子对象 { id, etag, name, sort_order, position }
    cJSON* group  = cJSON_GetObjectItemCaseSensitive(root, proto::kGroup);
    if (cJSON_IsObject(group)) {
        out.group_id   = json_str(group, proto::kId);
        out.group_name = json_str(group, proto::kName);
        out.group_etag = json_str(group, proto::kEtag);
    }
    cJSON* contents = cJSON_GetObjectItemCaseSensitive(root, proto::kContents);
    if (cJSON_IsArray(contents)) {
        cJSON* item = nullptr;
        cJSON_ArrayForEach(item, contents) {
            ContentMeta f;
            f.seq           = json_int(item, proto::kSeq, 0);
            f.content_id    = json_str(item, proto::kContentId);
            f.device_status_bar_text = json_str(item, proto::kDeviceStatusBarText);
            f.image_etag    = json_str(item, proto::kImageEtag);
            f.audio_etag    = json_str(item, proto::kAudioEtag);
            f.image_size    = json_int(item, proto::kImageSize, 0);
            f.audio_size    = json_int(item, proto::kAudioSize, 0);
            f.kind          = json_str(item, proto::kKind);
            cJSON* next_wake = cJSON_GetObjectItemCaseSensitive(item, proto::kNextWakeSec);
            f.has_next_wake_sec = cJSON_IsNumber(next_wake);
            f.next_wake_sec = f.has_next_wake_sec ? next_wake->valueint : 0;
            if (f.kind.empty()) f.kind = "image";
            out.contents.push_back(f);
        }
    }
    cJSON_Delete(root);
    return true;
}

static bool DownloadBinary(const std::string& path, const std::string& if_none_match,
                           std::vector<uint8_t>& out, bool& not_modified) {
    not_modified  = false;
    int  status   = 0;
    bool ok       = DoRequest(path, HTTP_METHOD_GET, "", out, &status, if_none_match, nullptr,
                              /*need_auth=*/true);
    if (!ok) return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }
    return !out.empty();
}

bool DownloadContentImage(const std::string& content_id, const std::string& if_none_match,
                          std::vector<uint8_t>& out, bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + content_id + "/image";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

bool DownloadContentAudio(const std::string& content_id, const std::string& if_none_match,
                          std::vector<uint8_t>& out, bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + content_id + "/audio";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

}  // namespace api
