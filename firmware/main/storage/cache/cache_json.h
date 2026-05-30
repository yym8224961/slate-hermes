#pragma once

#include <cstdint>
#include <string>

struct cJSON;

namespace cache::internal {

std::string JsonStringField(cJSON* root, const char* key);
int         JsonNonNegativeIntField(cJSON* root, const char* key, int default_value);
uint32_t    JsonUint32Field(cJSON* root, const char* key, uint32_t default_value);

}  // namespace cache::internal
