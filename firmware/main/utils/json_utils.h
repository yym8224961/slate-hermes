#pragma once

#include <cJSON.h>

#include <string>

namespace json_utils {

inline std::string JsonString(const cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : "";
}

inline int JsonInt(const cJSON* obj, const char* key, int fallback = 0) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsNumber(item) ? item->valueint : fallback;
}

inline bool JsonBool(const cJSON* obj, const char* key, bool fallback = false) {
    cJSON* item = cJSON_GetObjectItem(obj, key);
    return cJSON_IsBool(item) ? cJSON_IsTrue(item) : fallback;
}

inline std::string PrintUnformatted(const cJSON* root, const char* fallback) {
    if (!root)
        return fallback;
    char*       raw = cJSON_PrintUnformatted(root);
    std::string out(raw ? raw : fallback);
    cJSON_free(raw);
    return out;
}

inline std::string PrintAndDelete(cJSON* root, const char* fallback = "{}") {
    std::string out = PrintUnformatted(root, fallback);
    cJSON_Delete(root);
    return out;
}

inline std::string JsonStringLiteral(const std::string& value) {
    return PrintAndDelete(cJSON_CreateString(value.c_str()), "\"\"");
}

inline std::string JsonId(const cJSON* id) {
    if (!cJSON_IsNumber(id) && !cJSON_IsString(id))
        return "";
    return PrintUnformatted(id, "");
}

}  // namespace json_utils
