#include "scenes/hermes/hermes_layout.h"

#include <cassert>
#include <iostream>

int main() {
    using hermes::layout::ActionBar;
    using hermes::layout::ChatViewport;
    using hermes::layout::MessagesChanged;
    using hermes::layout::Overlaps;

    constexpr auto chat   = ChatViewport(300, 24);
    constexpr auto footer = ActionBar(300);

    static_assert(chat.y == 24);
    static_assert(chat.height == 236);
    static_assert(chat.Bottom() == 260);
    static_assert(footer.y == 260);
    static_assert(footer.height == 40);
    static_assert(footer.Bottom() == 300);
    static_assert(!Overlaps(chat, footer));

    assert(!MessagesChanged(2, "same", 2, "same"));
    assert(MessagesChanged(2, "same", 3, "same"));
    assert(MessagesChanged(2, "same", 2, "changed"));

    std::cout << "Hermes layout contract passed\n";
    return 0;
}
