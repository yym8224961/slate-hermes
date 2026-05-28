#pragma once

#include <cstddef>
#include <cstdint>

namespace epd {

struct Rect {
    int x = 0;
    int y = 0;
    int w = 0;
    int h = 0;
};

struct DiffResult {
    size_t bits  = 0;
    float  ratio = 0.0f;
};

int  Area(const Rect& r);
Rect Union(const Rect& a, const Rect& b);
Rect Clamp(const Rect& r, int width, int height);
Rect AlignX8(const Rect& r);

bool Rgb565IsWhite(uint16_t c, uint8_t threshold);
void SetPx1(uint8_t* fb, int width, int x, int y, bool white);
bool GetPx1(const uint8_t* fb, int width, int x, int y);
void Copy1bppInto(uint8_t* fb, int fb_w, int fb_h, int x, int y, int w, int h, const uint8_t* data);
void Copy1bppFrom(const uint8_t* fb, int fb_w, int fb_h, int x, int y, int w, int h, uint8_t* data);
void Pack1bppTo2683(uint8_t in, uint8_t& out0, uint8_t& out1);

DiffResult Diff(const uint8_t* a, const uint8_t* b, size_t len);

}  // namespace epd
