#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace util {

inline size_t Utf8CharLen(unsigned char ch) {
    if ((ch & 0x80) == 0)
        return 1;
    if ((ch & 0xE0) == 0xC0)
        return 2;
    if ((ch & 0xF0) == 0xE0)
        return 3;
    if ((ch & 0xF8) == 0xF0)
        return 4;
    return 1;
}

inline bool IsUtf8Continuation(unsigned char ch) {
    return (ch & 0xC0) == 0x80;
}

inline size_t ValidUtf8PrefixBytes(const std::string& value, size_t max_bytes) {
    size_t bytes = 0;
    while (bytes < value.size() && bytes < max_bytes) {
        const size_t len = Utf8CharLen(static_cast<unsigned char>(value[bytes]));
        if (bytes + len > value.size() || bytes + len > max_bytes)
            break;
        bool valid = true;
        for (size_t i = 1; i < len; ++i) {
            if (!IsUtf8Continuation(static_cast<unsigned char>(value[bytes + i]))) {
                valid = false;
                break;
            }
        }
        bytes += valid ? len : 1;
    }
    return bytes;
}

inline void CopyUtf8Truncated(char* out, size_t cap, const std::string& value) {
    if (cap == 0)
        return;
    const size_t bytes = ValidUtf8PrefixBytes(value, cap - 1);
    if (bytes > 0)
        std::memcpy(out, value.data(), bytes);
    out[bytes] = '\0';
}

inline std::string Utf8PrefixChars(const std::string& value, size_t max_chars) {
    size_t bytes = 0;
    size_t chars = 0;
    while (bytes < value.size() && chars < max_chars) {
        const size_t len = Utf8CharLen(static_cast<unsigned char>(value[bytes]));
        if (bytes + len > value.size())
            break;
        bool valid = true;
        for (size_t i = 1; i < len; ++i) {
            if (!IsUtf8Continuation(static_cast<unsigned char>(value[bytes + i]))) {
                valid = false;
                break;
            }
        }
        bytes += valid ? len : 1;
        ++chars;
    }
    return value.substr(0, bytes);
}

inline std::string TrimForScreen(const std::string& text, size_t max_len) {
    if (max_len == 0 || text.empty())
        return "";

    size_t pos   = 0;
    size_t count = 0;
    while (pos < text.size() && count < max_len) {
        size_t step = Utf8CharLen(static_cast<unsigned char>(text[pos]));
        if (pos + step > text.size())
            break;
        bool valid = true;
        for (size_t i = 1; i < step; ++i) {
            if (!IsUtf8Continuation(static_cast<unsigned char>(text[pos + i]))) {
                valid = false;
                break;
            }
        }
        if (!valid)
            step = 1;
        pos += step;
        ++count;
    }

    if (pos >= text.size())
        return text;
    return text.substr(0, pos) + "...";
}

inline bool DecodeUtf8Codepoint(const std::string& text, size_t pos, uint32_t& cp, size_t& step) {
    if (pos >= text.size())
        return false;

    const auto ch = static_cast<unsigned char>(text[pos]);
    if ((ch & 0x80) == 0) {
        cp   = ch;
        step = 1;
        return true;
    }

    uint32_t value = 0;
    if ((ch & 0xE0) == 0xC0) {
        value = ch & 0x1F;
        step  = 2;
    } else if ((ch & 0xF0) == 0xE0) {
        value = ch & 0x0F;
        step  = 3;
    } else if ((ch & 0xF8) == 0xF0) {
        value = ch & 0x07;
        step  = 4;
    } else {
        step = 1;
        return false;
    }

    if (pos + step > text.size()) {
        step = 1;
        return false;
    }
    for (size_t i = 1; i < step; ++i) {
        const auto cont = static_cast<unsigned char>(text[pos + i]);
        if (!IsUtf8Continuation(cont)) {
            step = 1;
            return false;
        }
        value = (value << 6) | (cont & 0x3F);
    }

    if ((step == 2 && value < 0x80) || (step == 3 && value < 0x800) || (step == 4 && value < 0x10000) ||
        value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) {
        step = 1;
        return false;
    }

    cp = value;
    return true;
}

inline bool IsSupportedDisplaySymbol(uint32_t cp) {
    switch (cp) {
        case 0x2600:
        case 0x2601:
        case 0x2602:
        case 0x2603:
        case 0x26A1:
        case 0x2744:
        case 0x279C:
        case 0x279D:
        case 0x279E:
        case 0x27A4:
            return true;
        default:
            return false;
    }
}

inline bool IsUnsupportedScreenCodepoint(uint32_t cp) {
    if (cp == 0xFFFD)
        return true;
    if (cp >= 0xFE00 && cp <= 0xFE0F)
        return true;
    if (cp >= 0xE0100 && cp <= 0xE01EF)
        return true;
    if (cp == 0x200D || (cp >= 0x200B && cp <= 0x200F))
        return true;
    if (cp >= 0x2600 && cp <= 0x27BF)
        return !IsSupportedDisplaySymbol(cp);
    if (cp >= 0x1F000)
        return true;
    return false;
}

inline std::string SanitizeForScreen(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    bool previous_space = false;

    for (size_t pos = 0; pos < text.size();) {
        uint32_t cp   = 0;
        size_t   step = 1;
        if (!DecodeUtf8Codepoint(text, pos, cp, step)) {
            pos += step;
            continue;
        }

        if (cp == '\r') {
            pos += step;
            continue;
        }
        if (cp == '\n' || cp == '\t' || cp == 0x00A0) {
            if (!previous_space && !out.empty()) {
                out.push_back(' ');
                previous_space = true;
            }
            pos += step;
            continue;
        }
        if (cp < 0x20 || cp == 0x7F || IsUnsupportedScreenCodepoint(cp)) {
            pos += step;
            continue;
        }

        out.append(text, pos, step);
        previous_space = false;
        pos += step;
    }

    while (!out.empty() && out.back() == ' ')
        out.pop_back();
    return out;
}

}  // namespace util
