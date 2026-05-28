#include "api_client.h"

#include <cJSON.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_log.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <utility>

#include "config.h"
#include "json_utils.h"
#include "protocol_keys.h"
#include "time_utils.h"

namespace {
constexpr char kTag[]                      = "Api";
constexpr int  kUnauthorizedResetThreshold = 5;
constexpr int  kDefaultTimeoutMs           = 8000;
constexpr int  kManifestTimeoutMs          = 15000;
constexpr int  kBinaryTimeoutMs            = 20000;

bool IsAllowedBaseUrl(const std::string& url) {
    if (url.empty() || url.size() > 256)
        return false;
    for (unsigned char ch : url) {
        if (ch <= 0x20 || ch == 0x7F)
            return false;
    }
    return url.rfind("https://", 0) == 0 || url.rfind("http://", 0) == 0;
}

}  // namespace

namespace api {

static std::string s_url;
static std::string s_mac;
static std::string s_secret;
// 统一保护可变全局配置，避免后台同步线程与设置线程并发 data race。
static std::mutex       s_state_mutex;
static UnauthorizedCb   s_unauth_cb;
static std::atomic<int> s_consecutive_401{0};
static std::atomic<bool> s_warned_http_auth{false};

void Init(const std::string& url, const std::string& mac, const std::string& device_secret) {
    std::lock_guard<std::mutex> lock(s_state_mutex);
    s_url    = url;
    s_mac    = mac;
    s_secret = device_secret;
}
void SetServerUrl(const std::string& url) {
    std::lock_guard<std::mutex> lock(s_state_mutex);
    s_url = url;
}
void SetSecret(const std::string& secret) {
    std::lock_guard<std::mutex> lock(s_state_mutex);
    s_secret = secret;
}
void SetUnauthorizedHandler(UnauthorizedCb cb) {
    std::lock_guard<std::mutex> lock(s_state_mutex);
    s_unauth_cb = std::move(cb);
}

namespace {

using json_utils::JsonBool;
using json_utils::JsonInt;
using json_utils::JsonString;

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
    cJSON*      root = cJSON_Parse(text.c_str());
    if (!root) {
        ESP_LOGW(kTag, "%s -> HTTP %d: non-json error body len=%u", path.c_str(), status, (unsigned)body.size());
        return;
    }
    auto get_str = [](cJSON* obj, const char* key) -> const char* {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(obj, key);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    const char* klass  = get_str(root, proto::kError);
    const char* code   = "";
    cJSON*      detail = cJSON_GetObjectItemCaseSensitive(root, proto::kDetail);
    if (cJSON_IsObject(detail)) {
        code = get_str(detail, proto::kCode);
    }
    ESP_LOGW(kTag, "%s -> HTTP %d error=%s code=%s", path.c_str(), status, klass, code);
    cJSON_Delete(root);
}

std::string UrlEncodePathSegment(const std::string& value) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string           out;
    out.reserve(value.size());
    for (unsigned char ch : value) {
        const bool safe = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ||
                          ch == '-' || ch == '_' || ch == '.' || ch == '~';
        if (safe) {
            out.push_back(static_cast<char>(ch));
        } else {
            out.push_back('%');
            out.push_back(kHex[ch >> 4]);
            out.push_back(kHex[ch & 0x0F]);
        }
    }
    return out;
}

void ParseContentMeta(cJSON* item, ContentMeta& out) {
    out.seq                    = JsonInt(item, proto::kSeq, 0);
    out.id                     = JsonString(item, proto::kId);
    out.content_etag           = JsonString(item, proto::kContentEtag);
    out.device_status_bar_text = JsonString(item, proto::kDeviceStatusBarText);
    out.image_etag             = JsonString(item, proto::kImageEtag);
    out.audio_etag             = JsonString(item, proto::kAudioEtag);
    out.image_size             = JsonInt(item, proto::kImageSize, 0);
    out.audio_size             = JsonInt(item, proto::kAudioSize, 0);
    out.kind                   = JsonString(item, proto::kKind);
    cJSON* next_wake           = cJSON_GetObjectItemCaseSensitive(item, proto::kNextWakeSec);
    out.has_next_wake_sec      = cJSON_IsNumber(next_wake);
    out.next_wake_sec          = out.has_next_wake_sec ? next_wake->valueint : 0;
    if (out.kind.empty())
        out.kind = "image";
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
static bool DoRequest(const std::string& path, esp_http_client_method_t method, const std::string& body_in,
                      std::vector<uint8_t>& body_out, int* status_out = nullptr, const std::string& if_none_match = "",
                      std::string* etag_out = nullptr, bool need_auth = true, int timeout_ms = kDefaultTimeoutMs) {
    const int64_t started_ms = time_utils::NowMs();
    std::string   base_url;
    {
        std::lock_guard<std::mutex> lock(s_state_mutex);
        base_url = s_url;
    }
    if (base_url.empty()) {
        ESP_LOGW(kTag, "Server URL not set");
        return false;
    }
    if (!IsAllowedBaseUrl(base_url)) {
        ESP_LOGW(kTag, "Server URL rejected");
        return false;
    }
    if (need_auth && base_url.rfind("http://", 0) == 0 && !s_warned_http_auth.exchange(true, std::memory_order_relaxed)) {
        ESP_LOGW(kTag, "Using HTTP for authenticated request %s", path.c_str());
    }
    std::string full = base_url;
    if (!full.empty() && full.back() == '/')
        full.pop_back();
    full += path;
    esp_http_client_config_t cfg = {};
    cfg.url                      = full.c_str();
    cfg.method                   = method;
    cfg.timeout_ms               = timeout_ms;
    cfg.disable_auto_redirect    = false;
    // 挂 IDF 内置 root CA bundle:HTTPS 必备(否则 TLS 握手无 CA 校验失败)。
    // 注意调用方需要确保系统时间已对时(SNTP),否则证书 NotBefore/NotAfter 校验过不去。
    cfg.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        ESP_LOGW(kTag, "HTTP init failed %s after %lldms", path.c_str(),
                 (long long)(time_utils::NowMs() - started_ms));
        return false;
    }

    if (need_auth) {
        // 锁里只复制 secret 字符串，拼接放到锁外，缩短临界区。
        std::string secret;
        {
            std::lock_guard<std::mutex> lock(s_state_mutex);
            secret = s_secret;
        }
        if (secret.empty()) {
            ESP_LOGW(kTag, "%s: need_auth but secret empty", path.c_str());
            esp_http_client_cleanup(client);
            return false;
        }
        const std::string bearer = "Bearer " + secret;
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
        ESP_LOGW(kTag, "Open %s failed after %lldms: %s", path.c_str(), (long long)(time_utils::NowMs() - started_ms),
                 esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return false;
    }
    if (!body_in.empty()) {
        int wn = esp_http_client_write(client, body_in.c_str(), body_in.size());
        if (wn != static_cast<int>(body_in.size())) {
            ESP_LOGW(kTag, "Write %s short after %lldms: %d/%u", path.c_str(),
                     (long long)(time_utils::NowMs() - started_ms), wn, (unsigned)body_in.size());
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    int     status         = esp_http_client_get_status_code(client);
    if (status_out)
        *status_out = status;
    if (etag_out)
        *etag_out = ReadEtagHeader(client);

    body_out.clear();
    if (status != 304) {
        // 防止异常响应耗尽堆内存。上限与后端音频转码 60 秒 PCM 上限对齐；
        // JSON API 与 1bpp 图片远小于这个值，音频资源也不会被合法 TTS 误拦截。
        constexpr size_t kMaxResponseBytes = static_cast<size_t>(AUDIO_MAX_PCM_BYTES);
        if (content_length > static_cast<int64_t>(kMaxResponseBytes)) {
            ESP_LOGW(kTag, "%s: Content-Length %lld exceeds %u B limit", path.c_str(), (long long)content_length,
                     (unsigned)kMaxResponseBytes);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
        if (content_length > 0)
            body_out.reserve(static_cast<size_t>(content_length));
        char buf[1024];
        while (true) {
            int n = esp_http_client_read(client, buf, sizeof(buf));
            if (n < 0) {
                ESP_LOGW(kTag, "%s: response read failed after %lldms: %d", path.c_str(),
                         (long long)(time_utils::NowMs() - started_ms), n);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return false;
            }
            if (n <= 0)
                break;
            body_out.insert(body_out.end(), buf, buf + n);
            if (body_out.size() > kMaxResponseBytes) {
                ESP_LOGW(kTag, "%s: response body exceeded %u B, aborting", path.c_str(), (unsigned)kMaxResponseBytes);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                return false;
            }
        }
        if (content_length > 0 && body_out.size() != static_cast<size_t>(content_length)) {
            ESP_LOGW(kTag, "%s: short response body after %lldms %u/%lld B", path.c_str(),
                     (long long)(time_utils::NowMs() - started_ms), (unsigned)body_out.size(),
                     (long long)content_length);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
    } else if (!esp_http_client_is_complete_data_received(client)) {
        char drain[128];
        while (!esp_http_client_is_complete_data_received(client)) {
            int n = esp_http_client_read(client, drain, sizeof(drain));
            if (n < 0) {
                ESP_LOGW(kTag, "%s: 304 drain failed after %lldms: %d", path.c_str(),
                         (long long)(time_utils::NowMs() - started_ms), n);
                break;
            }
            if (n == 0)
                break;
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status == 304) {
        s_consecutive_401.store(0, std::memory_order_relaxed);
        return true;
    }
    if (status / 100 == 2) {
        s_consecutive_401.store(0, std::memory_order_relaxed);
        return true;
    }
    if (status == 401 && need_auth) {
        const int count = s_consecutive_401.fetch_add(1, std::memory_order_relaxed) + 1;
        LogErrorEnvelope(path, status, body_out);
        ESP_LOGW(kTag, "%s -> 401 count=%d/%d", path.c_str(), count, kUnauthorizedResetThreshold);
        UnauthorizedCb cb;
        if (count >= kUnauthorizedResetThreshold) {
            std::lock_guard<std::mutex> lock(s_state_mutex);
            cb = s_unauth_cb;
        }
        if (cb) {
            cb();
        }
        return false;
    }
    s_consecutive_401.store(0, std::memory_order_relaxed);
    LogErrorEnvelope(path, status, body_out);
    return false;
}

static bool DoRequestJson(const std::string& path, esp_http_client_method_t method, const std::string& body_in,
                          std::string& body_out_str, bool need_auth = true) {
    std::vector<uint8_t> bytes;
    bool                 ok = DoRequest(path, method, body_in, bytes, nullptr, "", nullptr, need_auth);
    body_out_str.assign(bytes.begin(), bytes.end());
    return ok;
}

// ─── 私有 helper:解析 DeviceState JSON ────────────────────────────
namespace {

bool ParseDeviceState(const std::string& json, DeviceState& out) {
    cJSON* root = cJSON_Parse(json.c_str());
    if (!root)
        return false;

    cJSON* dev = cJSON_GetObjectItemCaseSensitive(root, proto::kDevice);
    if (cJSON_IsObject(dev)) {
        out.id          = JsonString(dev, proto::kId);
        out.device_name = JsonString(dev, proto::kName);
        out.bound       = JsonBool(dev, proto::kBound, false);
        out.pair_code   = JsonString(dev, proto::kPairCode);
        out.server_time = JsonString(dev, proto::kServerTime);
    }

    cJSON* group = cJSON_GetObjectItemCaseSensitive(root, proto::kGroup);
    if (cJSON_IsObject(group)) {
        out.has_group      = true;
        out.group_id       = JsonString(group, proto::kId);
        out.group_name     = JsonString(group, proto::kName);
        out.structure_etag = JsonString(group, proto::kStructureEtag);
        out.manifest_etag  = JsonString(group, proto::kManifestEtag);
        if (out.manifest_etag.empty()) {
            ESP_LOGW(kTag, "DeviceState group missing manifest_etag");
            cJSON_Delete(root);
            return false;
        }
        out.content_count    = JsonInt(group, proto::kContentCount, 0);
        out.group_sort_order = JsonInt(group, proto::kSortOrder, 0);
        cJSON* pos           = cJSON_GetObjectItemCaseSensitive(group, proto::kPosition);
        if (cJSON_IsObject(pos)) {
            out.position_current = JsonInt(pos, proto::kCurrent, 0);
            out.position_total   = JsonInt(pos, proto::kTotal, 0);
        }
    } else {
        out.has_group = false;
    }

    cJSON* current = cJSON_GetObjectItemCaseSensitive(root, proto::kCurrentContent);
    if (cJSON_IsObject(current)) {
        out.has_current_content = true;
        ParseContentMeta(current, out.current_content);
    } else {
        out.has_current_content = false;
    }

    cJSON_Delete(root);
    return true;
}

}  // namespace

// ─── 设备协议端点 ────────────────────────────────────────────────
bool Register(RegisterResult& out) {
    std::string mac;
    {
        std::lock_guard<std::mutex> lock(s_state_mutex);
        mac = s_mac;
    }
    cJSON* j = cJSON_CreateObject();
    if (!j) {
        ESP_LOGW(kTag, "Register: json allocation failed");
        return false;
    }
    cJSON_AddStringToObject(j, proto::kMac, mac.c_str());
    char* body = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    if (!body) {
        ESP_LOGW(kTag, "Register: body allocation failed");
        return false;
    }
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices";
    bool        ok   = DoRequestJson(path, HTTP_METHOD_POST, body, resp, /*need_auth=*/false);
    cJSON_free(body);
    if (!ok)
        return false;

    cJSON* root = cJSON_Parse(resp.c_str());
    if (!root) {
        ESP_LOGW(kTag, "Register: invalid json response");
        return false;
    }
    auto get_str = [&](const char* k) -> std::string {
        cJSON* v = cJSON_GetObjectItemCaseSensitive(root, k);
        return (cJSON_IsString(v) && v->valuestring) ? v->valuestring : "";
    };
    out.id            = get_str(proto::kId);
    out.device_secret = get_str(proto::kDeviceSecret);
    out.pair_code     = get_str(proto::kPairCode);
    cJSON_Delete(root);

    if (out.id.empty() || out.device_secret.empty() || out.pair_code.empty()) {
        ESP_LOGW(kTag, "Register: response missing required fields");
        return false;
    }
    return true;
}

bool Poll(const Telemetry& tel, DeviceState& out) {
    cJSON* root = cJSON_CreateObject();
    if (!root) {
        ESP_LOGW(kTag, "Poll: json allocation failed");
        return false;
    }

    // 仅在有非默认值的字段时构造 telemetry 对象。
    bool has_telemetry = tel.battery_pct >= 0 || tel.rssi_dbm != 0 || !tel.fw_version.empty() ||
                         !tel.current_group.empty() || tel.current_content_seq >= 0 || !tel.wake_reason.empty() ||
                         !tel.current_content_etag.empty() || !tel.manifest_etag.empty();
    if (has_telemetry) {
        cJSON* t = cJSON_CreateObject();
        if (!t) {
            ESP_LOGW(kTag, "Poll: telemetry allocation failed");
            cJSON_Delete(root);
            return false;
        }
        if (tel.battery_pct >= 0)
            cJSON_AddNumberToObject(t, proto::kBatteryPct, tel.battery_pct);
        if (tel.rssi_dbm != 0)
            cJSON_AddNumberToObject(t, proto::kRssiDbm, tel.rssi_dbm);
        if (!tel.fw_version.empty())
            cJSON_AddStringToObject(t, proto::kFwVersion, tel.fw_version.c_str());
        if (!tel.wake_reason.empty())
            cJSON_AddStringToObject(t, proto::kWakeReason, tel.wake_reason.c_str());
        if (!tel.current_group.empty())
            cJSON_AddStringToObject(t, proto::kCurrentGroup, tel.current_group.c_str());
        if (tel.current_content_seq >= 0)
            cJSON_AddNumberToObject(t, proto::kCurrentContentSeq, tel.current_content_seq);
        if (!tel.current_content_etag.empty())
            cJSON_AddStringToObject(t, proto::kCurrentContentEtag, tel.current_content_etag.c_str());
        if (!tel.manifest_etag.empty())
            cJSON_AddStringToObject(t, proto::kManifestEtag, tel.manifest_etag.c_str());
        cJSON_AddItemToObject(root, proto::kTelemetry, t);
    }

    char* body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!body) {
        ESP_LOGW(kTag, "Poll: body allocation failed");
        return false;
    }
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices/current/poll";
    bool        ok   = DoRequestJson(path, HTTP_METHOD_POST, body, resp);
    cJSON_free(body);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

// direction: "next" | "prev" → POST /api/v1/devices/current/group/{direction}
bool CycleGroup(const std::string& direction, DeviceState& out) {
    if (direction != "next" && direction != "prev")
        return false;
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices/current/group/" + direction;
    bool        ok   = DoRequestJson(path, HTTP_METHOD_POST, "", resp);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

bool SelectGroup(const std::string& gid, DeviceState& out) {
    cJSON* j = cJSON_CreateObject();
    if (!j) {
        ESP_LOGW(kTag, "SelectGroup: json allocation failed");
        return false;
    }
    cJSON_AddStringToObject(j, proto::kId, gid.c_str());
    char* body = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    if (!body) {
        ESP_LOGW(kTag, "SelectGroup: body allocation failed");
        return false;
    }
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices/current/group";
    bool        ok   = DoRequestJson(path, HTTP_METHOD_PUT, body, resp);
    cJSON_free(body);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

bool GetManifest(const std::string& group_id, const std::string& if_none_match, Manifest& out, bool& not_modified) {
    not_modified              = false;
    out                       = Manifest{};
    std::string          path = std::string(kApiPrefix) + "/groups/" + UrlEncodePathSegment(group_id) + "/manifest";
    std::vector<uint8_t> bytes;
    int                  status = 0;
    std::string          etag_out;
    bool                 ok = DoRequest(path, HTTP_METHOD_GET, "", bytes, &status, if_none_match, &etag_out,
                                        /*need_auth=*/true, kManifestTimeoutMs);
    if (!ok)
        return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }

    std::string resp(bytes.begin(), bytes.end());
    cJSON*      root = cJSON_Parse(resp.c_str());
    if (!root)
        return false;

    // 协议 v3：group 子对象 { id, structure_etag, manifest_etag, name, sort_order, position }
    cJSON* group = cJSON_GetObjectItemCaseSensitive(root, proto::kGroup);
    if (!cJSON_IsObject(group)) {
        ESP_LOGW(kTag, "GetManifest: response missing group");
        cJSON_Delete(root);
        return false;
    }
    out.group_id      = JsonString(group, proto::kId);
    out.group_name    = JsonString(group, proto::kName);
    out.manifest_etag = JsonString(group, proto::kManifestEtag);
    if (out.manifest_etag.empty()) {
        ESP_LOGW(kTag, "GetManifest: response missing manifest_etag");
        cJSON_Delete(root);
        return false;
    }
    cJSON* contents = cJSON_GetObjectItemCaseSensitive(root, proto::kContents);
    if (cJSON_IsArray(contents)) {
        cJSON* item = nullptr;
        cJSON_ArrayForEach(item, contents) {
            ContentMeta f;
            ParseContentMeta(item, f);
            out.contents.push_back(f);
        }
    }
    cJSON_Delete(root);
    return true;
}

static bool DownloadBinary(const std::string& path, const std::string& if_none_match, std::vector<uint8_t>& out,
                           bool& not_modified) {
    not_modified = false;
    int  status  = 0;
    bool ok      = DoRequest(path, HTTP_METHOD_GET, "", out, &status, if_none_match, nullptr,
                             /*need_auth=*/true, kBinaryTimeoutMs);
    if (!ok)
        return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }
    return !out.empty();
}

bool DownloadContentImage(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + UrlEncodePathSegment(id) + "/image";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

bool DownloadContentAudio(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + UrlEncodePathSegment(id) + "/audio";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

}  // namespace api
