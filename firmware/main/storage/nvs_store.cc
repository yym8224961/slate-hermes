#include "nvs_store.h"

#include <esp_log.h>
#include <nvs.h>

#include <cstring>

namespace {
constexpr char kTag[] = "NvsStore";

bool ValidName(const char* value) {
    return value && value[0] != '\0' && std::strlen(value) < NVS_KEY_NAME_MAX_SIZE;
}

bool ValidateNamespace(const char* ns) {
    if (ValidName(ns))
        return true;
    ESP_LOGW(kTag, "Invalid namespace: %s", ns ? ns : "<null>");
    return false;
}

bool ValidateKey(const char* ns, const char* key) {
    if (ValidName(key))
        return true;
    ESP_LOGW(kTag, "Invalid key for namespace %s: %s", ns ? ns : "<null>", key ? key : "<null>");
    return false;
}
}

namespace nvs_store {

std::string GetString(const char* ns, const char* key, const std::string& fallback) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return fallback;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK)
        return fallback;

    size_t len = 0;
    esp_err_t err = nvs_get_str(h, key, nullptr, &len);
    if (err != ESP_OK || len == 0) {
        nvs_close(h);
        return fallback;
    }

    std::string value;
    value.resize(len);
    err = nvs_get_str(h, key, value.data(), &len);
    nvs_close(h);
    if (err != ESP_OK)
        return fallback;

    while (!value.empty() && value.back() == '\0')
        value.pop_back();
    return value;
}

bool SetString(const char* ns, const char* key, const std::string& value) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return false;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "Open namespace %s failed", ns);
        return false;
    }
    esp_err_t err = nvs_set_str(h, key, value.c_str());
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Set %s/%s failed: %s", ns, key, esp_err_to_name(err));
        return false;
    }
    return true;
}

bool SetStrings(const char* ns, std::initializer_list<std::pair<const char*, std::string>> values) {
    if (!ValidateNamespace(ns))
        return false;
    for (const auto& item : values) {
        if (!ValidateKey(ns, item.first))
            return false;
    }

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "Open namespace %s failed", ns);
        return false;
    }
    esp_err_t err = ESP_OK;
    for (const auto& item : values) {
        err = nvs_set_str(h, item.first, item.second.c_str());
        if (err != ESP_OK)
            break;
    }
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Set strings in %s failed: %s", ns, esp_err_to_name(err));
        return false;
    }
    return true;
}

int32_t GetInt32(const char* ns, const char* key, int32_t fallback) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return fallback;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK)
        return fallback;
    int32_t value = fallback;
    esp_err_t err = nvs_get_i32(h, key, &value);
    nvs_close(h);
    return err == ESP_OK ? value : fallback;
}

bool SetInt32(const char* ns, const char* key, int32_t value) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return false;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "Open namespace %s failed", ns);
        return false;
    }
    esp_err_t err = nvs_set_i32(h, key, value);
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Set %s/%s failed: %s", ns, key, esp_err_to_name(err));
        return false;
    }
    return true;
}

int8_t GetInt8(const char* ns, const char* key, int8_t fallback) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return fallback;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK)
        return fallback;
    int8_t value = fallback;
    esp_err_t err = nvs_get_i8(h, key, &value);
    nvs_close(h);
    return err == ESP_OK ? value : fallback;
}

bool SetInt8(const char* ns, const char* key, int8_t value) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return false;

    nvs_handle_t h = 0;
    if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(kTag, "Open namespace %s failed", ns);
        return false;
    }
    esp_err_t err = nvs_set_i8(h, key, value);
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(kTag, "Set %s/%s failed: %s", ns, key, esp_err_to_name(err));
        return false;
    }
    return true;
}

bool EraseKey(const char* ns, const char* key) {
    if (!ValidateNamespace(ns) || !ValidateKey(ns, key))
        return false;

    nvs_handle_t h = 0;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND)
        return true;
    if (err != ESP_OK)
        return false;

    err = nvs_erase_key(h, key);
    if (err == ESP_ERR_NVS_NOT_FOUND)
        err = ESP_OK;
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK;
}

bool EraseNamespace(const char* ns) {
    if (!ValidateNamespace(ns))
        return false;

    nvs_handle_t h = 0;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND)
        return true;
    if (err != ESP_OK)
        return false;
    err = nvs_erase_all(h);
    if (err == ESP_OK)
        err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND;
}

}  // namespace nvs_store
