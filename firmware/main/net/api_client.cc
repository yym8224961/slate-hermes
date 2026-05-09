#include "api_client.h"

#include <cJSON.h>
#include <esp_http_client.h>
#include <esp_log.h>

#include <cstring>

namespace {
constexpr char kTag[] = "Api";
constexpr char kDeviceMacHeader[] = "X-Device-Mac";
}

namespace api {

static std::string s_url;
static std::string s_mac;

void Init(const std::string& url, const std::string& mac) {
    s_url = url;
    s_mac = mac;
}
void SetServerUrl(const std::string& url) { s_url = url; }

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

}  // namespace

// API 路径前缀(对应 backend shared API_PREFIX = "/api/v1")。
constexpr char kApiPrefix[] = "/api/v1";

// 同步 HTTP 请求。
//   path/method/body_in - 请求(path 已带 /api/v1 前缀)
//   body_out            - 响应 body
//   status_out          - HTTP 状态码(可空)
//   if_none_match       - 非空时设 If-None-Match 头
//   etag_out            - 响应头 ETag(可空,去引号)
//   send_mac            - 默认 true:加 X-Device-Mac 头。POST /api/v1/devices(register)
//                         不需要,设 false
static bool DoRequest(const std::string& path, esp_http_client_method_t method,
                      const std::string& body_in, std::vector<uint8_t>& body_out,
                      int* status_out                = nullptr,
                      const std::string& if_none_match = "",
                      std::string* etag_out          = nullptr,
                      bool send_mac                  = true) {
    if (s_url.empty()) {
        ESP_LOGW(kTag, "server url not set");
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
    cfg.crt_bundle_attach         = nullptr;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return false;

    if (send_mac && !s_mac.empty()) {
        esp_http_client_set_header(client, kDeviceMacHeader, s_mac.c_str());
    }
    if (method == HTTP_METHOD_POST && !body_in.empty()) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
    }
    if (!if_none_match.empty()) {
        std::string h = "\"" + if_none_match + "\"";
        esp_http_client_set_header(client, "If-None-Match", h.c_str());
    }

    esp_err_t err = esp_http_client_open(client, body_in.size());
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "open %s failed: %s", path.c_str(), esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return false;
    }

    if (method == HTTP_METHOD_POST && !body_in.empty()) {
        int wn = esp_http_client_write(client, body_in.c_str(), body_in.size());
        if (wn != static_cast<int>(body_in.size())) {
            ESP_LOGW(kTag, "write %s short: %d/%u", path.c_str(), wn, (unsigned)body_in.size());
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return false;
        }
    }

    int content_length = esp_http_client_fetch_headers(client);
    int status         = esp_http_client_get_status_code(client);
    if (status_out) *status_out = status;
    if (etag_out) *etag_out     = ReadEtagHeader(client);

    body_out.clear();
    if (status != 304) {
        if (content_length > 0) body_out.reserve(content_length);
        char buf[1024];
        while (true) {
            int n = esp_http_client_read(client, buf, sizeof(buf));
            if (n <= 0) break;
            body_out.insert(body_out.end(), buf, buf + n);
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status == 304) return true;
    if (status / 100 != 2) {
        ESP_LOGW(kTag, "%s → HTTP %d", path.c_str(), status);
        return false;
    }
    return true;
}

static bool DoRequestJson(const std::string& path, esp_http_client_method_t method,
                          const std::string& body_in, std::string& body_out_str,
                          bool send_mac = true) {
    std::vector<uint8_t> bytes;
    bool                 ok = DoRequest(path, method, body_in, bytes, nullptr, "", nullptr, send_mac);
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

    cJSON* dev = cJSON_GetObjectItemCaseSensitive(root, "device");
    if (cJSON_IsObject(dev)) {
        out.device_id   = get_str(dev, "id");
        out.device_name = get_str(dev, "name");
        out.server_time = get_str(dev, "server_time");
    }

    cJSON* group = cJSON_GetObjectItemCaseSensitive(root, "group");
    if (cJSON_IsObject(group)) {
        out.has_group         = true;
        out.group_id          = get_str(group, "id");
        out.group_etag        = get_str(group, "etag");
        out.frame_count       = get_int(group, "frame_count", 0);
        out.default_frame_seq = get_int(group, "default_frame_seq", 0);
        out.group_sort_order  = get_int(group, "sort_order", 0);
        cJSON* pos = cJSON_GetObjectItemCaseSensitive(group, "position");
        if (cJSON_IsObject(pos)) {
            out.position_current = get_int(pos, "current", 0);
            out.position_total   = get_int(pos, "total", 0);
        }
    } else {
        out.has_group = false;
    }

    out.poll_interval_s = get_int(root, "poll_interval_s", 60);

    cJSON_Delete(root);
    return true;
}

}  // namespace

// ─── 设备协议端点 ────────────────────────────────────────────────
bool Register(const std::string& name) {
    cJSON* j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "mac", s_mac.c_str());
    if (!name.empty()) cJSON_AddStringToObject(j, "name", name.c_str());
    char* body = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    std::string resp;
    std::string path = std::string(kApiPrefix) + "/devices";
    bool ok = DoRequestJson(path, HTTP_METHOD_POST, body, resp, /*send_mac=*/false);
    cJSON_free(body);
    return ok;
}

bool Poll(const Telemetry& tel, DeviceState& out) {
    cJSON* root = cJSON_CreateObject();

    // 仅在有非默认值的字段时构造 telemetry 对象。
    bool has_telemetry =
        tel.battery_pct >= 0 || tel.rssi_dbm != 0 ||
        !tel.fw_version.empty() || !tel.current_group.empty() ||
        tel.current_frame_seq != 0;
    if (has_telemetry) {
        cJSON* t = cJSON_CreateObject();
        if (tel.battery_pct >= 0) cJSON_AddNumberToObject(t, "battery_pct", tel.battery_pct);
        if (tel.rssi_dbm != 0)    cJSON_AddNumberToObject(t, "rssi_dbm", tel.rssi_dbm);
        if (!tel.fw_version.empty())
            cJSON_AddStringToObject(t, "fw_version", tel.fw_version.c_str());
        if (!tel.current_group.empty())
            cJSON_AddStringToObject(t, "current_group", tel.current_group.c_str());
        cJSON_AddNumberToObject(t, "current_frame_seq", tel.current_frame_seq);
        cJSON_AddItemToObject(root, "telemetry", t);
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
    cJSON_AddStringToObject(j, "id", gid.c_str());
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
    // dual-auth 端点:带 X-Device-Mac 让 server 走设备身份。
    bool ok = DoRequest(path, HTTP_METHOD_GET, "", bytes, &status, if_none_match, &etag_out,
                        /*send_mac=*/true);
    if (!ok) return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }

    std::string  resp(bytes.begin(), bytes.end());
    cJSON* root = cJSON_Parse(resp.c_str());
    if (!root) return false;

    cJSON* gid    = cJSON_GetObjectItemCaseSensitive(root, "group_id");
    cJSON* etag   = cJSON_GetObjectItemCaseSensitive(root, "group_etag");
    cJSON* dft    = cJSON_GetObjectItemCaseSensitive(root, "default_frame_seq");
    cJSON* frames = cJSON_GetObjectItemCaseSensitive(root, "frames");

    if (cJSON_IsString(gid)) out.group_id = gid->valuestring;
    if (cJSON_IsString(etag)) out.group_etag = etag->valuestring;
    if (cJSON_IsNumber(dft)) out.default_frame_seq = dft->valueint;

    if (cJSON_IsArray(frames)) {
        cJSON* item = nullptr;
        cJSON_ArrayForEach(item, frames) {
            FrameMeta f;
            cJSON* seq = cJSON_GetObjectItemCaseSensitive(item, "sort_order");
            cJSON* cap = cJSON_GetObjectItemCaseSensitive(item, "caption");
            cJSON* ie  = cJSON_GetObjectItemCaseSensitive(item, "image_etag");
            cJSON* ae  = cJSON_GetObjectItemCaseSensitive(item, "audio_etag");
            cJSON* is  = cJSON_GetObjectItemCaseSensitive(item, "image_size");
            cJSON* as  = cJSON_GetObjectItemCaseSensitive(item, "audio_size");
            if (cJSON_IsNumber(seq)) f.seq = seq->valueint;
            if (cJSON_IsString(cap)) f.caption = cap->valuestring;
            if (cJSON_IsString(ie)) f.image_etag = ie->valuestring;
            if (cJSON_IsString(ae)) f.audio_etag = ae->valuestring;
            if (cJSON_IsNumber(is)) f.image_size = is->valueint;
            if (cJSON_IsNumber(as)) f.audio_size = as->valueint;
            out.frames.push_back(f);
        }
    }
    cJSON_Delete(root);
    return true;
}

static bool DownloadBinary(const std::string& path, const std::string& if_none_match,
                           std::vector<uint8_t>& out, bool& not_modified) {
    not_modified  = false;
    int  status   = 0;
    // dual-auth 资源端点:带 X-Device-Mac 走设备身份。
    bool ok       = DoRequest(path, HTTP_METHOD_GET, "", out, &status, if_none_match, nullptr,
                              /*send_mac=*/true);
    if (!ok) return false;
    if (status == 304) {
        not_modified = true;
        return true;
    }
    return !out.empty();
}

bool DownloadFrameImage(const std::string& group_id, int seq, const std::string& if_none_match,
                        std::vector<uint8_t>& out, bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/groups/" + group_id + "/frames/" +
                       std::to_string(seq) + "/image";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

bool DownloadFrameAudio(const std::string& group_id, int seq, const std::string& if_none_match,
                        std::vector<uint8_t>& out, bool& not_modified) {
    std::string path = std::string(kApiPrefix) + "/groups/" + group_id + "/frames/" +
                       std::to_string(seq) + "/audio";
    return DownloadBinary(path, if_none_match, out, not_modified);
}

}  // namespace api
