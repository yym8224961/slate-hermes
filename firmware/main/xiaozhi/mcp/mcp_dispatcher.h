#pragma once

#include <cJSON.h>

#include <functional>
#include <string>

namespace xiaozhi::mcp {

struct Dispatcher {
    std::function<void(const std::string&)> send;
    std::function<std::string()>            device_status_json;
    std::function<void(int)>                set_volume;
};

bool DispatchMessage(const cJSON* root, const Dispatcher& dispatcher);

}  // namespace xiaozhi::mcp
