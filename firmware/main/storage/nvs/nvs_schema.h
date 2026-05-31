#pragma once

#include <cstddef>

#include <nvs.h>

namespace nvs_schema {

template <std::size_t N>
constexpr bool FitsName(const char (&)[N]) {
    return N > 1 && N <= NVS_KEY_NAME_MAX_SIZE;
}

inline constexpr char kNet[]      = "slate.net";
inline constexpr char kAudio[]    = "slate.audio";
inline constexpr char kChat[]     = "slate.chat";
inline constexpr char kChatMqtt[] = "slate.chat.mq";
inline constexpr char kChatWs[]   = "slate.chat.ws";
inline constexpr char kLegacy[]   = "slate";

namespace net {
inline constexpr char kSsid[]   = "ssid";
inline constexpr char kPwd[]    = "pwd";
inline constexpr char kUrl[]    = "url";
inline constexpr char kDevId[]  = "dev_id";
inline constexpr char kDevSec[] = "dev_sec";
}  // namespace net

namespace audio {
inline constexpr char kVolume[] = "volume";
}  // namespace audio

namespace chat {
inline constexpr char kUuid[] = "uuid";
}  // namespace chat

namespace mqtt {
inline constexpr char kEndpoint[]  = "endpoint";
inline constexpr char kClientId[]  = "client_id";
inline constexpr char kUsername[]  = "username";
inline constexpr char kPassword[]  = "password";
inline constexpr char kPubTopic[]  = "pub_topic";
inline constexpr char kKeepalive[] = "keepalive";
}  // namespace mqtt

namespace ws {
inline constexpr char kUrl[]     = "url";
inline constexpr char kToken[]   = "token";
inline constexpr char kVersion[] = "version";
}  // namespace ws

#define SLATE_NVS_ASSERT_NAME(name) static_assert(::nvs_schema::FitsName(name), #name " exceeds NVS name limit")

SLATE_NVS_ASSERT_NAME(kNet);
SLATE_NVS_ASSERT_NAME(kAudio);
SLATE_NVS_ASSERT_NAME(kChat);
SLATE_NVS_ASSERT_NAME(kChatMqtt);
SLATE_NVS_ASSERT_NAME(kChatWs);
SLATE_NVS_ASSERT_NAME(kLegacy);

SLATE_NVS_ASSERT_NAME(net::kSsid);
SLATE_NVS_ASSERT_NAME(net::kPwd);
SLATE_NVS_ASSERT_NAME(net::kUrl);
SLATE_NVS_ASSERT_NAME(net::kDevId);
SLATE_NVS_ASSERT_NAME(net::kDevSec);

SLATE_NVS_ASSERT_NAME(audio::kVolume);

SLATE_NVS_ASSERT_NAME(chat::kUuid);

SLATE_NVS_ASSERT_NAME(mqtt::kEndpoint);
SLATE_NVS_ASSERT_NAME(mqtt::kClientId);
SLATE_NVS_ASSERT_NAME(mqtt::kUsername);
SLATE_NVS_ASSERT_NAME(mqtt::kPassword);
SLATE_NVS_ASSERT_NAME(mqtt::kPubTopic);
SLATE_NVS_ASSERT_NAME(mqtt::kKeepalive);

SLATE_NVS_ASSERT_NAME(ws::kUrl);
SLATE_NVS_ASSERT_NAME(ws::kToken);
SLATE_NVS_ASSERT_NAME(ws::kVersion);

#undef SLATE_NVS_ASSERT_NAME

}  // namespace nvs_schema
