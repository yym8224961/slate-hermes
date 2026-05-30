#pragma once

#include <string>

namespace xiaozhi::mcp {

std::string BuildDeviceStatusJson();
std::string TextResultJson(const std::string& text);
std::string ToolListResultJson();
std::string JsonRpcResult(const std::string& id, const std::string& result);
std::string JsonRpcError(const std::string& id, int code, const std::string& message);

}  // namespace xiaozhi::mcp
