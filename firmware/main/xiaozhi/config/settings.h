#pragma once

#include <cstdint>
#include <string>

namespace xiaozhi {
namespace settings {

struct MqttConfig {
    std::string endpoint;
    std::string client_id;
    std::string username;
    std::string password;
    std::string publish_topic;
    int32_t     keepalive = 240;
};

struct WebsocketConfig {
    std::string url;
    std::string token;
    int32_t     version = 0;
};

std::string GetUuid();

bool SaveMqtt(const MqttConfig& cfg);
bool LoadMqtt(MqttConfig& out);
void ClearMqtt();

bool SaveWebsocket(const WebsocketConfig& cfg);
bool LoadWebsocket(WebsocketConfig& out);
void ClearWebsocket();

bool HasProtocolConfig();

int  GetVolume();
void SetVolume(int level);

void ClearAll();

}  // namespace settings
}  // namespace xiaozhi
