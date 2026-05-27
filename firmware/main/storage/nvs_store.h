#pragma once

#include <cstdint>
#include <initializer_list>
#include <utility>
#include <string>

namespace nvs_store {

std::string GetString(const char* ns, const char* key, const std::string& fallback = "");
bool        SetString(const char* ns, const char* key, const std::string& value);
bool        SetStrings(const char* ns, std::initializer_list<std::pair<const char*, std::string>> values);

int32_t GetInt32(const char* ns, const char* key, int32_t fallback = 0);
bool    SetInt32(const char* ns, const char* key, int32_t value);

int8_t GetInt8(const char* ns, const char* key, int8_t fallback = 0);
bool   SetInt8(const char* ns, const char* key, int8_t value);

bool EraseKey(const char* ns, const char* key);
bool EraseNamespace(const char* ns);

}  // namespace nvs_store
