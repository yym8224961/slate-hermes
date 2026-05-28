#include "epd_utils.h"

#include <algorithm>
#include <cstring>

namespace epd {

int Area(const Rect& r) {
    return (r.w > 0 && r.h > 0) ? r.w * r.h : 0;
}

Rect Union(const Rect& a, const Rect& b) {
    if (Area(a) == 0)
        return b;
    if (Area(b) == 0)
        return a;
    const int x1 = std::min(a.x, b.x);
    const int y1 = std::min(a.y, b.y);
    const int x2 = std::max(a.x + a.w, b.x + b.w);
    const int y2 = std::max(a.y + a.h, b.y + b.h);
    return {x1, y1, x2 - x1, y2 - y1};
}

Rect Clamp(const Rect& r, int width, int height) {
    const int x1 = std::max(0, r.x);
    const int y1 = std::max(0, r.y);
    const int x2 = std::min(width, r.x + r.w);
    const int y2 = std::min(height, r.y + r.h);
    return {x1, y1, x2 - x1, y2 - y1};
}

Rect AlignX8(const Rect& r) {
    const int x0 = (r.x / 8) * 8;
    const int x1 = ((r.x + r.w + 7) / 8) * 8;
    return {x0, r.y, x1 - x0, r.h};
}

bool Rgb565IsWhite(uint16_t c, uint8_t threshold) {
    const uint8_t r5 = (c >> 11) & 0x1F;
    const uint8_t g6 = (c >> 5) & 0x3F;
    const uint8_t b5 = c & 0x1F;
    const uint8_t r8 = (r5 * 255 + 15) / 31;
    const uint8_t g8 = (g6 * 255 + 31) / 63;
    const uint8_t b8 = (b5 * 255 + 15) / 31;
    return ((77 * r8 + 150 * g8 + 29 * b8) >> 8) >= threshold;
}

void SetPx1(uint8_t* fb, int width, int x, int y, bool white) {
    const int      bpr = (width + 7) >> 3;
    const uint32_t idx = static_cast<uint32_t>(y) * bpr + static_cast<uint32_t>(x >> 3);
    const uint8_t  bit = 1 << (7 - (x & 7));
    if (white)
        fb[idx] |= bit;
    else
        fb[idx] &= ~bit;
}

bool GetPx1(const uint8_t* fb, int width, int x, int y) {
    const int      bpr = (width + 7) >> 3;
    const uint32_t idx = static_cast<uint32_t>(y) * bpr + static_cast<uint32_t>(x >> 3);
    const uint8_t  bit = 1 << (7 - (x & 7));
    return (fb[idx] & bit) != 0;
}

void Copy1bppInto(uint8_t* fb, int fb_w, int fb_h, int x, int y, int w, int h, const uint8_t* data) {
    const int src_bpr = (w + 7) >> 3;
    const int dst_bpr = (fb_w + 7) >> 3;
    if (x == 0 && w == fb_w) {
        for (int row = 0; row < h; row++) {
            const int dy = y + row;
            if (dy < 0 || dy >= fb_h)
                continue;
            std::memcpy(fb + dy * dst_bpr, data + row * src_bpr, src_bpr);
        }
        return;
    }
    for (int row = 0; row < h; row++) {
        const int dy = y + row;
        if (dy < 0 || dy >= fb_h)
            continue;
        const uint8_t* src_row = data + row * src_bpr;
        for (int col = 0; col < w; col++) {
            const int dx = x + col;
            if (dx < 0 || dx >= fb_w)
                continue;
            const bool white = (src_row[col >> 3] >> (7 - (col & 7))) & 1;
            SetPx1(fb, fb_w, dx, dy, white);
        }
    }
}

void Copy1bppFrom(const uint8_t* fb, int fb_w, int fb_h, int x, int y, int w, int h, uint8_t* data) {
    const int dst_bpr = (w + 7) >> 3;
    const int src_bpr = (fb_w + 7) >> 3;
    if (x == 0 && w == fb_w) {
        for (int row = 0; row < h; row++) {
            const int sy = y + row;
            if (sy < 0 || sy >= fb_h) {
                std::memset(data + row * dst_bpr, 0xFF, dst_bpr);
                continue;
            }
            std::memcpy(data + row * dst_bpr, fb + sy * src_bpr, src_bpr);
        }
        return;
    }
    std::memset(data, 0xFF, dst_bpr * h);
    for (int row = 0; row < h; row++) {
        const int sy = y + row;
        if (sy < 0 || sy >= fb_h)
            continue;
        uint8_t* dst_row = data + row * dst_bpr;
        for (int col = 0; col < w; col++) {
            const int sx = x + col;
            if (sx < 0 || sx >= fb_w)
                continue;
            const bool    white = GetPx1(fb, fb_w, sx, sy);
            const uint8_t bit   = 1 << (7 - (col & 7));
            if (white)
                dst_row[col >> 3] |= bit;
            else
                dst_row[col >> 3] &= ~bit;
        }
    }
}

void Pack1bppTo2683(uint8_t in, uint8_t& out0, uint8_t& out1) {
    uint8_t b0 = 0;
    uint8_t b1 = 0;
    for (uint8_t i = 0; i < 8; ++i) {
        const uint8_t bit = (in >> (7 - i)) & 1;
        if (i < 4)
            b0 |= bit << (8 - 2 * (i + 1));
        else
            b1 |= bit << (14 - 2 * i);
    }
    out0 = b0;
    out1 = b1;
}

DiffResult Diff(const uint8_t* a, const uint8_t* b, size_t len) {
    DiffResult result;
    for (size_t i = 0; i < len; ++i) {
        const uint8_t x = a[i] ^ b[i];
        if (x)
            result.bits += __builtin_popcount(x);
    }
    result.ratio = len == 0 ? 0.0f : static_cast<float>(result.bits) / (len * 8);
    return result;
}

}  // namespace epd
