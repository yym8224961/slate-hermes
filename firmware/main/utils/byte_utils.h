#pragma once

#include <arpa/inet.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace util {

inline uint16_t ReadBe16(const char* data) {
    uint16_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return ntohs(value);
}

inline uint32_t ReadBe32(const char* data) {
    uint32_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return ntohl(value);
}

inline void WriteBe16(char* data, uint16_t value) {
    value = htons(value);
    std::memcpy(data, &value, sizeof(value));
}

inline void WriteBe32(char* data, uint32_t value) {
    value = htonl(value);
    std::memcpy(data, &value, sizeof(value));
}

inline uint8_t HexValue(char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    return 0;
}

inline std::string HexLower(const uint8_t* data, size_t len) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string           out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(kHex[data[i] >> 4]);
        out.push_back(kHex[data[i] & 0x0f]);
    }
    return out;
}

}  // namespace util
