#include "xiaozhi_config_client.h"

#include <cJSON.h>
#include <esp_app_desc.h>
#include <esp_chip_info.h>
#include <esp_crt_bundle.h>
#include <esp_efuse.h>
#include <esp_efuse_table.h>
#include <esp_flash.h>
#ifdef SOC_HMAC_SUPPORTED
#include <esp_hmac.h>
#endif
#include <esp_http_client.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_psram.h>
#include <sys/time.h>

#include <cstring>

#include "xiaozhi_settings.h"

namespace {
constexpr char kTag[] = "XiaoCfg";

esp_err_t HttpEventHandler(esp_http_client_event_t* evt) {
    auto* out = static_cast<std::string*>(evt->user_data);
    if (evt->event_id == HTTP_EVENT_ON_DATA && out && evt->data && evt->data_len > 0) {
        out->append(static_cast<const char*>(evt->data), evt->data_len);
    }
    return ESP_OK;
}

std::string GetJsonString(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}

int GetJsonInt(cJSON* obj, const char* key, int fallback = 0) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsNumber(item) ? item->valueint : fallback;
}

std::string PrintAndDelete(cJSON* root) {
    char* raw = cJSON_PrintUnformatted(root);
    std::string out(raw ? raw : "{}");
    cJSON_free(raw);
    cJSON_Delete(root);
    return out;
}

std::string HexLower(const uint8_t* data, size_t len) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(kHex[data[i] >> 4]);
        out.push_back(kHex[data[i] & 0x0f]);
    }
    return out;
}

std::string ActivationUrl() {
    std::string url = xiaozhi::ConfigClient::kConfigUrl;
    if (!url.empty() && url.back() != '/')
        url += '/';
    url += "activate";
    return url;
}
}  // namespace

namespace xiaozhi {

std::string ConfigClient::DeviceId() const {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char buf[18];
    std::snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return buf;
}

std::string ConfigClient::UserAgent() const {
    const auto* app = esp_app_get_description();
    std::string ua = kBoardName;
    ua += "/";
    ua += app ? app->version : "unknown";
    return ua;
}

std::string ConfigClient::SerialNumber() const {
#ifdef ESP_EFUSE_BLOCK_USR_DATA
    uint8_t serial_number[33] = {0};
    if (esp_efuse_read_field_blob(ESP_EFUSE_USER_DATA, serial_number, 32 * 8) == ESP_OK && serial_number[0] != 0) {
        serial_number[32] = 0;
        return std::string(reinterpret_cast<char*>(serial_number), 32);
    }
#endif
    return "";
}

std::string ConfigClient::SystemInfoJson() const {
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    const auto* app = esp_app_get_description();

    cJSON* root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 2);
    cJSON_AddStringToObject(root, "language", kLanguage);

    uint32_t flash_size = 0;
    if (esp_flash_get_size(nullptr, &flash_size) == ESP_OK)
        cJSON_AddNumberToObject(root, "flash_size", flash_size);
    cJSON_AddNumberToObject(root, "psram_size", esp_psram_get_size());
    cJSON_AddNumberToObject(root, "minimum_free_heap_size", esp_get_minimum_free_heap_size());
    cJSON_AddStringToObject(root, "mac_address", DeviceId().c_str());
    cJSON_AddStringToObject(root, "uuid", settings::GetUuid().c_str());
    cJSON_AddStringToObject(root, "chip_model_name", CONFIG_IDF_TARGET);

    cJSON* chip_info = cJSON_CreateObject();
    cJSON_AddNumberToObject(chip_info, "model", chip.model);
    cJSON_AddNumberToObject(chip_info, "cores", chip.cores);
    cJSON_AddNumberToObject(chip_info, "revision", chip.revision);
    cJSON_AddNumberToObject(chip_info, "features", chip.features);
    cJSON_AddItemToObject(root, "chip_info", chip_info);

    cJSON* application = cJSON_CreateObject();
    cJSON_AddStringToObject(application, "name", app ? app->project_name : "slate");
    cJSON_AddStringToObject(application, "version", app ? app->version : "unknown");
    std::string compile_time;
    if (app) {
        compile_time = std::string(app->date) + "T" + app->time + "Z";
        cJSON_AddStringToObject(application, "compile_time", compile_time.c_str());
        cJSON_AddStringToObject(application, "idf_version", app->idf_ver);
        cJSON_AddStringToObject(application, "elf_sha256", HexLower(app->app_elf_sha256, sizeof(app->app_elf_sha256)).c_str());
    }
    cJSON_AddItemToObject(root, "application", application);

    cJSON* partitions = cJSON_CreateArray();
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, nullptr);
    while (it) {
        const esp_partition_t* partition = esp_partition_get(it);
        cJSON* item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "label", partition->label);
        cJSON_AddNumberToObject(item, "type", partition->type);
        cJSON_AddNumberToObject(item, "subtype", partition->subtype);
        cJSON_AddNumberToObject(item, "address", partition->address);
        cJSON_AddNumberToObject(item, "size", partition->size);
        cJSON_AddItemToArray(partitions, item);
        it = esp_partition_next(it);
    }
    cJSON_AddItemToObject(root, "partition_table", partitions);

    cJSON* ota = cJSON_CreateObject();
    const esp_partition_t* running = esp_ota_get_running_partition();
    cJSON_AddStringToObject(ota, "label", running ? running->label : "unknown");
    cJSON_AddItemToObject(root, "ota", ota);

    cJSON* display = cJSON_CreateObject();
    cJSON_AddBoolToObject(display, "monochrome", true);
    cJSON_AddNumberToObject(display, "width", 400);
    cJSON_AddNumberToObject(display, "height", 300);
    cJSON_AddItemToObject(root, "display", display);

    cJSON* board = cJSON_CreateObject();
    cJSON_AddStringToObject(board, "type", kBoardType);
    cJSON_AddStringToObject(board, "name", kBoardName);
    cJSON_AddStringToObject(board, "mac", DeviceId().c_str());
    cJSON_AddItemToObject(root, "board", board);

    return PrintAndDelete(root);
}

void ConfigClient::SetupHeaders(esp_http_client_handle_t client,
                                const std::string& device_id,
                                const std::string& client_id,
                                const std::string& user_agent,
                                const std::string& serial_number) const {
    esp_http_client_set_header(client, "Activation-Version", serial_number.empty() ? "1" : "2");
    esp_http_client_set_header(client, "Device-Id", device_id.c_str());
    esp_http_client_set_header(client, "Client-Id", client_id.c_str());
    if (!serial_number.empty())
        esp_http_client_set_header(client, "Serial-Number", serial_number.c_str());
    esp_http_client_set_header(client, "User-Agent", user_agent.c_str());
    esp_http_client_set_header(client, "Accept-Language", kLanguage);
    esp_http_client_set_header(client, "Content-Type", "application/json");
}

std::string ConfigClient::ActivationPayload(const std::string& challenge, const std::string& serial_number) const {
    if (serial_number.empty()) {
        ESP_LOGW(kTag, "Activation challenge present but serial number is empty; using empty payload");
        return "{}";
    }

    std::string hmac_hex;
#ifdef SOC_HMAC_SUPPORTED
    uint8_t hmac_result[32] = {0};
    esp_err_t ret = esp_hmac_calculate(HMAC_KEY0,
                                       reinterpret_cast<const uint8_t*>(challenge.data()),
                                       challenge.size(),
                                       hmac_result);
    if (ret != ESP_OK) {
        ESP_LOGE(kTag, "Activation HMAC failed: %s", esp_err_to_name(ret));
        return "{}";
    }
    hmac_hex = HexLower(hmac_result, sizeof(hmac_result));
#else
    ESP_LOGW(kTag, "Activation HMAC unsupported by target");
#endif

    cJSON* payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "algorithm", "hmac-sha256");
    cJSON_AddStringToObject(payload, "serial_number", serial_number.c_str());
    cJSON_AddStringToObject(payload, "challenge", challenge.c_str());
    cJSON_AddStringToObject(payload, "hmac", hmac_hex.c_str());
    return PrintAndDelete(payload);
}

esp_err_t ConfigClient::Activate(const std::string& challenge) {
    if (challenge.empty()) {
        ESP_LOGW(kTag, "Activate skipped: empty challenge");
        return ESP_FAIL;
    }

    std::string body;
    const std::string device_id = DeviceId();
    const std::string client_id = settings::GetUuid();
    const std::string user_agent = UserAgent();
    const std::string serial_number = SerialNumber();
    const std::string payload = ActivationPayload(challenge, serial_number);
    const std::string url = ActivationUrl();

    esp_http_client_config_t cfg = {};
    cfg.url                     = url.c_str();
    cfg.method                  = HTTP_METHOD_POST;
    cfg.timeout_ms              = 15000;
    cfg.crt_bundle_attach       = esp_crt_bundle_attach;
    cfg.event_handler           = HttpEventHandler;
    cfg.user_data               = &body;
    cfg.disable_auto_redirect   = false;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client)
        return ESP_FAIL;
    SetupHeaders(client, device_id, client_id, user_agent, serial_number);
    esp_http_client_set_post_field(client, payload.c_str(), payload.size());

    esp_err_t err = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Activate failed: err=%s status=%d body_len=%u",
                 esp_err_to_name(err),
                 status,
                 static_cast<unsigned>(body.size()));
    }
    esp_http_client_cleanup(client);

    if (err != ESP_OK)
        return err;
    if (status == 202)
        return ESP_ERR_TIMEOUT;
    return status == 200 ? ESP_OK : ESP_FAIL;
}

ConfigResult ConfigClient::Fetch() {
    ConfigResult result;
    std::string  body;
    std::string  request = SystemInfoJson();
    const std::string device_id = DeviceId();
    const std::string client_id = settings::GetUuid();
    const std::string user_agent = UserAgent();
    const std::string serial_number = SerialNumber();

    esp_http_client_config_t cfg = {};
    cfg.url                     = kConfigUrl;
    cfg.method                  = HTTP_METHOD_POST;
    cfg.timeout_ms              = 15000;
    cfg.crt_bundle_attach       = esp_crt_bundle_attach;
    cfg.event_handler           = HttpEventHandler;
    cfg.user_data               = &body;
    cfg.disable_auto_redirect   = false;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        result.error = "HTTP 初始化失败";
        return result;
    }
    SetupHeaders(client, device_id, client_id, user_agent, serial_number);
    esp_http_client_set_post_field(client, request.c_str(), request.size());

    esp_err_t err = esp_http_client_perform(client);
    result.http_status = esp_http_client_get_status_code(client);
    if (err != ESP_OK) {
        result.error = esp_err_to_name(err);
        ESP_LOGW(kTag, "Fetch failed: %s", result.error.c_str());
        esp_http_client_cleanup(client);
        return result;
    }
    esp_http_client_cleanup(client);

    if (result.http_status != 200) {
        result.error = "HTTP " + std::to_string(result.http_status);
        ESP_LOGW(kTag, "Fetch status=%d body_len=%u",
                 result.http_status,
                 static_cast<unsigned>(body.size()));
        return result;
    }

    cJSON* root = cJSON_Parse(body.c_str());
    if (!root) {
        result.error = "配置响应不是 JSON";
        return result;
    }

    if (cJSON* activation = cJSON_GetObjectItem(root, "activation"); cJSON_IsObject(activation)) {
        result.activation_message = GetJsonString(activation, "message");
        result.activation_code    = GetJsonString(activation, "code");
        result.has_activation     = !result.activation_code.empty();
        result.activation_challenge = GetJsonString(activation, "challenge");
        result.has_activation_challenge = !result.activation_challenge.empty();
        result.activation_timeout_ms = GetJsonInt(activation, "timeout_ms", 30000);
    }

    if (cJSON* mqtt = cJSON_GetObjectItem(root, "mqtt"); cJSON_IsObject(mqtt)) {
        settings::MqttConfig m;
        m.endpoint      = GetJsonString(mqtt, "endpoint");
        m.client_id     = GetJsonString(mqtt, "client_id");
        m.username      = GetJsonString(mqtt, "username");
        m.password      = GetJsonString(mqtt, "password");
        m.publish_topic = GetJsonString(mqtt, "publish_topic");
        m.keepalive     = GetJsonInt(mqtt, "keepalive", 240);
        if (settings::SaveMqtt(m)) {
            result.has_protocol = true;
        }
    }

    if (cJSON* websocket = cJSON_GetObjectItem(root, "websocket"); cJSON_IsObject(websocket)) {
        settings::WebsocketConfig ws;
        ws.url     = GetJsonString(websocket, "url");
        ws.token   = GetJsonString(websocket, "token");
        ws.version = GetJsonInt(websocket, "version", 0);
        if (settings::SaveWebsocket(ws)) {
            result.has_protocol = true;
        }
    }

    if (cJSON* server_time = cJSON_GetObjectItem(root, "server_time"); cJSON_IsObject(server_time)) {
        cJSON* timestamp = cJSON_GetObjectItem(server_time, "timestamp");
        cJSON* timezone_offset = cJSON_GetObjectItem(server_time, "timezone_offset");
        if (cJSON_IsNumber(timestamp)) {
            double ts = timestamp->valuedouble;
            if (cJSON_IsNumber(timezone_offset)) {
                ts += static_cast<double>(timezone_offset->valueint) * 60.0 * 1000.0;
            }
            timeval tv = {};
            tv.tv_sec  = static_cast<time_t>(ts / 1000.0);
            tv.tv_usec = static_cast<suseconds_t>(static_cast<long long>(ts) % 1000) * 1000;
            if (settimeofday(&tv, nullptr) == 0) {
                result.server_time_synced = true;
            }
        }
    }

    cJSON_Delete(root);
    result.ok = true;
    result.has_protocol = result.has_protocol || settings::HasProtocolConfig();
    return result;
}

}  // namespace xiaozhi
