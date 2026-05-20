#pragma once

// HTTP client 封装(所有 server 通讯走这里)。单例,Init() 一次。
//
// 端点:
//   POST /api/v1/devices
//   POST /api/v1/devices/current/poll
//   POST /api/v1/devices/current/group/next|prev
//   PUT  /api/v1/devices/current/group
//   GET  /api/v1/groups/:gid/manifest
//   GET  /api/v1/contents/:contentId/image|audio

#include <functional>
#include <string>
#include <vector>

namespace api {

struct DeviceState {
    std::string id;
    std::string device_name;
    bool        bound = false;
    std::string pair_code;
    std::string server_time;

    bool        has_group = false;
    std::string group_id;
    std::string group_name;
    std::string group_etag;
    int         content_count    = 0;
    int         group_sort_order = 0;
    int         position_current = 0;
    int         position_total   = 0;
};

struct RegisterResult {
    std::string id;
    std::string device_secret;
    std::string pair_code;
    bool        reclaimed = false;
};

struct ContentMeta {
    int         seq = 0;
    std::string id;
    std::string device_status_bar_text;
    std::string image_etag;
    std::string audio_etag;
    int         image_size = 0;
    int         audio_size = 0;
    std::string kind;
    bool        has_next_wake_sec = false;
    int         next_wake_sec     = 0;
};

struct Manifest {
    std::string              group_id;
    std::string              group_name;
    std::string              group_etag;
    std::vector<ContentMeta> contents;
};

struct Telemetry {
    int         battery_pct = -1;
    int         rssi_dbm    = 0;
    std::string fw_version;
    int         free_heap = -1;
    std::string fw_build_ts;
    std::string current_group;
    int         current_content_seq = -1;
};

void Init(const std::string& server_url, const std::string& mac, const std::string& device_secret);
void SetServerUrl(const std::string& url);
void SetSecret(const std::string& secret);

using UnauthorizedCb = std::function<void()>;
void SetUnauthorizedHandler(UnauthorizedCb cb);

bool Register(RegisterResult& out);
bool Poll(const Telemetry& tel, DeviceState& out);
bool CycleGroup(const std::string& direction, DeviceState& out);
bool SelectGroup(const std::string& gid, DeviceState& out);

bool GetManifest(const std::string& group_id, const std::string& if_none_match, Manifest& out, bool& not_modified);

bool DownloadContentImage(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified);
bool DownloadContentAudio(const std::string& id, const std::string& if_none_match, std::vector<uint8_t>& out,
                          bool& not_modified);

}  // namespace api
