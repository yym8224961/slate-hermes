#include "hermes/hermes_limits.h"

#include <cassert>
#include <string>

int main() {
    using hermes::Base64EncodedSize;
    using hermes::CaptureSamplesForChunk;

    static_assert(hermes::kMaxRecordSamples == 240000);
    static_assert(Base64EncodedSize(hermes::kMaxRecordSamples * sizeof(int16_t)) == 640000);

    assert(CaptureSamplesForChunk(0, 512) == 512);
    assert(CaptureSamplesForChunk(239616, 512) == 384);
    assert(CaptureSamplesForChunk(240000, 512) == 0);

    std::string chinese;
    for (int i = 0; i < 513; ++i)
        chinese += "你";
    const std::string limited = hermes::LimitHistoryText(chinese);
    assert(limited.size() == 512 * 3);
    assert(hermes::LimitHistoryText("hello") == "hello");

    const std::string font_safe = util::FilterUnsupportedGlyphs(
        "你ᄀ啦", [](uint32_t cp) { return cp == 0x4F60 || cp == 0x5566 || cp == '?'; });
    assert(font_safe == "你?啦");
    return 0;
}
