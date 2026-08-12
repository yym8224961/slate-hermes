#pragma once

#include <cstddef>
#include <string_view>

namespace hermes::layout {

constexpr int kBottomActionBarHeight = 40;

struct Rect {
    int y;
    int height;

    constexpr int Bottom() const {
        return y + height;
    }
};

constexpr Rect ChatViewport(int screen_height, int status_bar_height) {
    return {status_bar_height, screen_height - status_bar_height - kBottomActionBarHeight};
}

constexpr Rect ActionBar(int screen_height) {
    return {screen_height - kBottomActionBarHeight, kBottomActionBarHeight};
}

constexpr bool Overlaps(Rect lhs, Rect rhs) {
    return lhs.y < rhs.Bottom() && rhs.y < lhs.Bottom();
}

constexpr bool MessagesChanged(size_t rendered_count, std::string_view rendered_key, size_t next_count,
                               std::string_view next_key) {
    return rendered_count != next_count || rendered_key != next_key;
}

}  // namespace hermes::layout
