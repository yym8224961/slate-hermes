#include "storage/cache/cache_json.h"

#include <cJSON.h>

namespace cache::internal {

std::string JsonStringField(cJSON* root, const char* key) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsString(value) && value->valuestring ? value->valuestring : "";
}

int JsonNonNegativeIntField(cJSON* root, const char* key, int default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (cJSON_IsNumber(value) && value->valueint >= 0)
        return value->valueint;
    return default_value;
}

uint32_t JsonUint32Field(cJSON* root, const char* key, uint32_t default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(value))
        return default_value;
    const double v = value->valuedouble;
    if (v < 0.0 || v > static_cast<double>(UINT32_MAX))
        return default_value;
    return static_cast<uint32_t>(v);
}

}  // namespace cache::internal
