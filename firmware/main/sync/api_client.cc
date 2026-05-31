#include "sync/api_client.h"

#include <cJSON.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_log.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <utility>

#include "bsp/config.h"
#include "utils/json_utils.h"
#include "utils/time_utils.h"

namespace {
constexpr char kTag[]                      = "Api";
constexpr int  kUnauthorizedResetThreshold = 5;
constexpr int  kDefaultTimeoutMs           = 8000;
constexpr int  kManifestTimeoutMs          = 15000;
constexpr int  kBinaryTimeoutMs            = 20000;

namespace proto {

inline constexpr char kAudioEtag[]           = "audio_etag";
inline constexpr char kAudioSize[]           = "audio_size";
inline constexpr char kBatteryPct[]          = "battery_pct";
inline constexpr char kBound[]               = "bound";
inline constexpr char kCode[]                = "code";
inline constexpr char kContentCount[]        = "content_count";
inline constexpr char kContentEtag[]         = "content_etag";
inline constexpr char kContents[]            = "contents";
inline constexpr char kCurrent[]             = "current";
inline constexpr char kCurrentContent[]      = "current_content";
inline constexpr char kCurrentContentSeq[]   = "current_content_seq";
inline constexpr char kCurrentContentEtag[]  = "current_content_etag";
inline constexpr char kCurrentGroup[]        = "current_group";
inline constexpr char kDeviceStatusBarText[] = "device_status_bar_text";
inline constexpr char kDetail[]              = "detail";
inline constexpr char kDevice[]              = "device";
inline constexpr char kDeviceSecret[]        = "device_secret";
inline constexpr char kError[]               = "error";
inline constexpr char kFwVersion[]           = "fw_version";
inline constexpr char kGroup[]               = "group";
inline constexpr char kId[]                  = "id";
inline constexpr char kImageEtag[]           = "image_etag";
inline constexpr char kImageSize[]           = "image_size";
inline constexpr char kKind[]                = "kind";
inline constexpr char kManifestEtag[]        = "manifest_etag";
inline constexpr char kMac[]                 = "mac";
inline constexpr char kName[]                = "name";
inline constexpr char kNextWakeSec[]         = "next_wake_sec";
inline constexpr char kPairCode[]            = "pair_code";
inline constexpr char kPosition[]            = "position";
inline constexpr char kRssiDbm[]             = "rssi_dbm";
inline constexpr char kSeq[]                 = "seq";
inline constexpr char kServerTime[]          = "server_time";
inline constexpr char kSortOrder[]           = "sort_order";
inline constexpr char kStructureEtag[]       = "structure_etag";
inline constexpr char kTelemetry[]           = "telemetry";
inline constexpr char kTotal[]               = "total";
inline constexpr char kWakeReason[]          = "wake_reason";

}  // namespace proto

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

ApiClient::ApiClient(std::string server_url, std::string mac, std::string device_secret)
    : server_url_(std::move(server_url)), mac_(std::move(mac)), secret_(std::move(device_secret)) {
}

void ApiClient::Configure(const std::string& server_url, const std::string& mac, const std::string& device_secret) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    server_url_ = server_url;
    mac_        = mac;
    secret_     = device_secret;
}

void ApiClient::SetServerUrl(const std::string& url) {
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        server_url_ = url;
    }
    // host 可能变了,丢弃旧连接。锁顺序:此处不持 state_mutex_ 再取 conn_mutex_。
    ResetConnection();
}

void ApiClient::SetSecret(const std::string& secret) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    secret_ = secret;
}

void ApiClient::SetUnauthorizedHandler(UnauthorizedCb cb) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    unauthorized_cb_ = std::move(cb);
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

// 取得可复用的持久 client。base_url 变化(换 host)时重建。调用者持 conn_mutex_。
esp_http_client_handle_t ApiClient::EnsureClientLocked(const std::string& base_url) {
    if (conn_ && conn_base_url_ != base_url) {
        esp_http_client_cleanup(conn_);
        conn_ = nullptr;
        conn_base_url_.clear();
    }
    if (!conn_) {
        esp_http_client_config_t cfg = {};
        cfg.url                      = base_url.c_str();
        cfg.timeout_ms               = kDefaultTimeoutMs;
        cfg.disable_auto_redirect    = false;
        // 挂 IDF 内置 root CA bundle:HTTPS 必备(否则 TLS 握手无 CA 校验失败)。
        // 注意调用方需要确保系统时间已对时(SNTP),否则证书 NotBefore/NotAfter 校验过不去。
        cfg.crt_bundle_attach = esp_crt_bundle_attach;
        // keep-alive:同一 host 的多次请求复用 TCP/TLS,免去每请求重做握手。
        cfg.keep_alive_enable = true;
        conn_                 = esp_http_client_init(&cfg);
        if (conn_)
            conn_base_url_ = base_url;
    }
    return conn_;
}

// 销毁持久连接(进入异常态、或主动回收内存时)。调用者持 conn_mutex_。
void ApiClient::DropConnectionLocked() {
    if (conn_) {
        esp_http_client_cleanup(conn_);
        conn_ = nullptr;
        conn_base_url_.clear();
    }
}

void ApiClient::ResetConnection() {
    std::lock_guard<std::mutex> lock(conn_mutex_);
    DropConnectionLocked();
}

// 同步 HTTP 请求。
//   path/method/body_in - 请求(path 已带 /api/v1 前缀)
//   body_out            - 响应 body
//   status_out          - HTTP 状态码(可空)
//   if_none_match       - 非空时设 If-None-Match 头
//   etag_out            - 响应头 ETag(可空,去引号)
//   need_auth           - true:加 Authorization: Bearer secret_。register 端点设 false。
//
// 401:仅对 need_auth=true 的请求触发 unauth_cb (注册路径无鉴权,401 没意义)。
bool ApiClient::DoRequest(const std::string& path, esp_http_client_method_t method, const std::string& body_in,
                          std::vector<uint8_t>& body_out, int* status_out, const std::string& if_none_match,
                          std::string* etag_out, bool need_auth, int timeout_ms) {
    const int64_t started_ms = time_utils::NowMs();
    std::string   base_url, secret;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        base_url = server_url_;
        secret   = secret_;
    }
    if (base_url.empty()) {
        ESP_LOGW(kTag, "Server URL not set");
        return false;
    }
    if (!IsAllowedBaseUrl(base_url)) {
        ESP_LOGW(kTag, "Server URL rejected");
        return false;
    }
    if (need_auth && secret.empty()) {
        ESP_LOGW(kTag, "%s: need_auth but secret empty", path.c_str());
        return false;
    }
    if (need_auth && base_url.rfind("http://", 0) == 0 &&
        !warned_http_auth_.exchange(true, std::memory_order_relaxed)) {
        ESP_LOGW(kTag, "Using HTTP for authenticated request %s", path.c_str());
    }
    std::string normalized_base = base_url;
    if (!normalized_base.empty() && normalized_base.back() == '/')
        normalized_base.pop_back();
    const std::string full = normalized_base + path;

    // 防止异常响应耗尽堆内存。上限与后端音频转码 60 秒 PCM 上限对齐；
    // JSON API 与 1bpp 图片远小于这个值，音频资源也不会被合法 TTS 误拦截。
    constexpr size_t kMaxResponseBytes = static_cast<size_t>(AUDIO_MAX_PCM_BYTES);

    // 整个请求事务串行化:持久 conn_ 不能并发使用。
    std::lock_guard<std::mutex> conn_lock(conn_mutex_);

    // 最多两次尝试:复用的 keep-alive socket 可能已被对端关闭,open 失败时重建重试一次。
    for (int attempt = 0; attempt < 2; ++attempt) {
        const bool               reused = (conn_ != nullptr);
        esp_http_client_handle_t client = EnsureClientLocked(normalized_base);
        if (!client) {
            ESP_LOGW(kTag, "HTTP init failed %s after %lldms", path.c_str(),
                     (long long)(time_utils::NowMs() - started_ms));
            return false;
        }

        esp_http_client_set_url(client, full.c_str());
        esp_http_client_set_method(client, method);
        esp_http_client_set_timeout_ms(client, timeout_ms);

        // 复用 handle 时上次请求设置的 header 会残留,先逐个清掉再按需设置。
        esp_http_client_delete_header(client, "Authorization");
        esp_http_client_delete_header(client, "Content-Type");
        esp_http_client_delete_header(client, "If-None-Match");
        if (need_auth) {
            const std::string bearer = "Bearer " + secret;
            esp_http_client_set_header(client, "Authorization", bearer.c_str());
        }
        if (!body_in.empty())
            esp_http_client_set_header(client, "Content-Type", "application/json");
        if (!if_none_match.empty()) {
            std::string h = "\"" + if_none_match + "\"";
            esp_http_client_set_header(client, "If-None-Match", h.c_str());
        }

        // open 会建立连接并发送请求头。复用的死 socket 在此暴露,可安全重试(请求体尚未发出)。
        esp_err_t err = esp_http_client_open(client, body_in.size());
        if (err != ESP_OK) {
            ESP_LOGW(kTag, "Open %s failed after %lldms: %s", path.c_str(),
                     (long long)(time_utils::NowMs() - started_ms), esp_err_to_name(err));
            DropConnectionLocked();
            if (reused && attempt == 0)
                continue;  // 可能是过期 keep-alive socket,用新连接重试
            return false;
        }
        if (!body_in.empty()) {
            int wn = esp_http_client_write(client, body_in.c_str(), body_in.size());
            if (wn != static_cast<int>(body_in.size())) {
                ESP_LOGW(kTag, "Write %s short after %lldms: %d/%u", path.c_str(),
                         (long long)(time_utils::NowMs() - started_ms), wn, (unsigned)body_in.size());
                DropConnectionLocked();
                return false;  // 请求头已发出,不重试(POST 非幂等)
            }
        }

        int64_t content_length = esp_http_client_fetch_headers(client);
        if (content_length < 0) {
            ESP_LOGW(kTag, "%s: fetch_headers failed after %lldms", path.c_str(),
                     (long long)(time_utils::NowMs() - started_ms));
            DropConnectionLocked();
            return false;
        }
        int status = esp_http_client_get_status_code(client);
        if (status_out)
            *status_out = status;
        if (etag_out)
            *etag_out = ReadEtagHeader(client);

        body_out.clear();
        bool failed = false;
        if (status != 304) {
            if (content_length > static_cast<int64_t>(kMaxResponseBytes)) {
                ESP_LOGW(kTag, "%s: Content-Length %lld exceeds %u B limit", path.c_str(), (long long)content_length,
                         (unsigned)kMaxResponseBytes);
                DropConnectionLocked();
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
                    failed = true;
                    break;
                }
                if (n <= 0)
                    break;
                body_out.insert(body_out.end(), buf, buf + n);
                if (body_out.size() > kMaxResponseBytes) {
                    ESP_LOGW(kTag, "%s: response body exceeded %u B, aborting", path.c_str(),
                             (unsigned)kMaxResponseBytes);
                    failed = true;
                    break;
                }
            }
            if (!failed && content_length > 0 && body_out.size() != static_cast<size_t>(content_length)) {
                ESP_LOGW(kTag, "%s: short response body after %lldms %u/%lld B", path.c_str(),
                         (long long)(time_utils::NowMs() - started_ms), (unsigned)body_out.size(),
                         (long long)content_length);
                failed = true;
            }
        } else if (!esp_http_client_is_complete_data_received(client)) {
            char drain[128];
            while (!esp_http_client_is_complete_data_received(client)) {
                int n = esp_http_client_read(client, drain, sizeof(drain));
                if (n < 0) {
                    ESP_LOGW(kTag, "%s: 304 drain failed after %lldms: %d", path.c_str(),
                             (long long)(time_utils::NowMs() - started_ms), n);
                    failed = true;
                    break;
                }
                if (n == 0)
                    break;
            }
        }

        if (failed) {
            DropConnectionLocked();
            return false;
        }
        // 成功:close 但不 cleanup,keep-alive 保留 socket 供后续请求复用。
        esp_http_client_close(client);

        if (status == 304) {
            consecutive_401_.store(0, std::memory_order_relaxed);
            return true;
        }
        if (status / 100 == 2) {
            consecutive_401_.store(0, std::memory_order_relaxed);
            return true;
        }
        if (status == 401 && need_auth) {
            const int count = consecutive_401_.fetch_add(1, std::memory_order_relaxed) + 1;
            LogErrorEnvelope(path, status, body_out);
            ESP_LOGW(kTag, "%s -> 401 count=%d/%d", path.c_str(), count, kUnauthorizedResetThreshold);
            UnauthorizedCb cb;
            if (count >= kUnauthorizedResetThreshold) {
                std::lock_guard<std::mutex> lock(state_mutex_);
                cb = unauthorized_cb_;
            }
            if (cb) {
                cb();
            }
            return false;
        }
        consecutive_401_.store(0, std::memory_order_relaxed);
        LogErrorEnvelope(path, status, body_out);
        return false;
    }
    return false;
}

bool ApiClient::DoRequestJson(const std::string& path, esp_http_client_method_t method, const std::string& body_in,
                              std::string& body_out_str, bool need_auth) {
    std::vector<uint8_t> bytes;
    bool ok = DoRequest(path, method, body_in, bytes, nullptr, "", nullptr, need_auth, kDefaultTimeoutMs);
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
bool ApiClient::Register(RegisterResult& out) {
    std::string mac;
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        mac = mac_;
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

bool ApiClient::Poll(const Telemetry& tel, DeviceState& out) {
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
    bool        ok   = DoRequestJson(path, HTTP_METHOD_POST, body, resp, /*need_auth=*/true);
    cJSON_free(body);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

// direction: "next" | "prev" → POST /api/v1/devices/current/group/{direction}
bool ApiClient::CycleGroup(const std::string& direction, DeviceState& out) {
    if (direction != "next" && direction != "prev")
        return false;
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices/current/group/" + direction;
    bool        ok   = DoRequestJson(path, HTTP_METHOD_POST, "", resp, /*need_auth=*/true);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

bool ApiClient::SelectGroup(const std::string& gid, DeviceState& out) {
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
    bool        ok   = DoRequestJson(path, HTTP_METHOD_PUT, body, resp, /*need_auth=*/true);
    cJSON_free(body);
    if (!ok)
        return false;
    return ParseDeviceState(resp, out);
}

bool ApiClient::GetManifest(const std::string& group_id, const std::string& if_none_match, Manifest& out,
                            bool& not_modified) {
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

bool ApiClient::DownloadBinary(const std::string& path, const std::string& if_none_match, std::vector<uint8_t>& out,
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

bool ApiClient::DownloadContentImage(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                                     bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + UrlEncodePathSegment(id) + "/image";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

bool ApiClient::DownloadContentAudio(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                                     bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/contents/" + UrlEncodePathSegment(id) + "/audio";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

ApiClient& DefaultClient() {
    static ApiClient client;
    return client;
}

void Init(const std::string& server_url, const std::string& mac, const std::string& device_secret) {
    DefaultClient().Configure(server_url, mac, device_secret);
}

void SetServerUrl(const std::string& url) {
    DefaultClient().SetServerUrl(url);
}

void SetSecret(const std::string& secret) {
    DefaultClient().SetSecret(secret);
}

void SetUnauthorizedHandler(UnauthorizedCb cb) {
    DefaultClient().SetUnauthorizedHandler(std::move(cb));
}

void ResetConnection() {
    DefaultClient().ResetConnection();
}

bool Register(RegisterResult& out) {
    return DefaultClient().Register(out);
}

bool Poll(const Telemetry& tel, DeviceState& out) {
    return DefaultClient().Poll(tel, out);
}

bool CycleGroup(const std::string& direction, DeviceState& out) {
    return DefaultClient().CycleGroup(direction, out);
}

bool SelectGroup(const std::string& gid, DeviceState& out) {
    return DefaultClient().SelectGroup(gid, out);
}

bool GetManifest(const std::string& group_id, const std::string& if_none_match, Manifest& out, bool& not_modified) {
    return DefaultClient().GetManifest(group_id, if_none_match, out, not_modified);
}

bool DownloadContentImage(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified) {
    return DefaultClient().DownloadContentImage(id, if_none_match, out, not_modified);
}

bool DownloadContentAudio(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified) {
    return DefaultClient().DownloadContentAudio(id, if_none_match, out, not_modified);
}

}  // namespace api
