#pragma once

// HTTP client 封装(所有 server 通讯走这里)。单例,Init() 一次。
//
// 鉴权:首次启动 NVS 没 device_secret 时调 Register() (无鉴权,body 带 mac);
// 拿到响应里的 device_secret 后用 SetSecret() 切到 Bearer 模式,
// 之后所有 /me/* 端点和资源下载都用 Authorization: Bearer <secret>。
//
// 401:DoRequest 检测到 → 调 SetUnauthorizedHandler() 注册的回调
// (典型实现:cred::ClearSecret() + esp_restart() → 走 self-reset)。
//
// 端点:
//   POST /api/v1/devices/register     首次/重置后调,无鉴权,body {mac}
//   POST /api/v1/me/poll              主轮询,Bearer 鉴权,响应含 bound + pair_code
//   POST /api/v1/me/group/next|prev   cycle
//   PUT  /api/v1/me/group             选指定 group(body {id})
//   GET  /api/v1/groups/:gid/manifest     Bearer
//   GET  /api/v1/contents/:contentId/image|audio   Bearer

#include <functional>
#include <string>
#include <vector>

namespace api {

struct DeviceState {
    // 设备信息
    std::string device_id;
    std::string device_name;
    bool        bound = false;  // owner_user_id != null
    std::string pair_code;      // unbound 时由后端下发,bound 时为空
    std::string server_time;

    // group:为空(has_group=false)表示当前未选组
    bool        has_group = false;
    std::string group_id;
    std::string group_name;       // 当前组中文名,用于状态栏 / boot splash 文案
    std::string group_etag;
    int         content_count     = 0;
    int         group_sort_order  = 0;
    int         position_current  = 0;
    int         position_total    = 0;
};

struct RegisterResult {
    std::string device_id;
    std::string device_secret;  // 64 字符 hex,调用方负责立刻 cred::SaveSecret()
    std::string pair_code;      // 6 位 [A-Z2-9]
    bool        reclaimed = false;
};

// 后端协议 v3 起内容用 content_id(cuid) 寻址；image/audio 端点改为
// /contents/:contentId/image|audio，与 reorder 时 seq 漂移解耦。
// dynamic 内容的 next_wake_sec 由后端按 nextRenderAt-now 计算；0 表示立即可刷新。
struct ContentMeta {
    int         seq;  // group 内位置序号(JSON key: seq)
    std::string content_id;  // 全局稳定 cuid，设备拼 URL: GET /contents/:id/image
    std::string caption;
    std::string image_etag;
    std::string audio_etag;
    int         image_size       = 0;
    int         audio_size       = 0;
    std::string kind;             // "image" | "dynamic"
    int         next_wake_sec = 0;  // 0 = 立即/无周期刷新
};

struct Manifest {
    std::string              group_id;
    std::string              group_name;     // 同 DeviceState.group_name
    std::string              group_etag;
    std::vector<ContentMeta> contents;
};

// poll 携带的 telemetry。值为 < 0 / 空字符串 表示不上报该字段(server 不覆盖原值)。
struct Telemetry {
    int         battery_pct = -1;
    int         rssi_dbm    = 0;  // 0 = 不上报
    std::string fw_version;
    std::string current_group;
    int         current_content_seq = -1;
};

// mac 仅用于 Register() body,不参与受保护 API 鉴权。
// device_secret 可空,表示尚未注册;Register() 成功后调 SetSecret()。
void Init(const std::string& server_url, const std::string& mac, const std::string& device_secret);
void SetServerUrl(const std::string& url);
void SetSecret(const std::string& secret);

// 任意受保护请求收到 401 时调用。典型实现:cred::ClearSecret() + esp_restart()。
using UnauthorizedCb = std::function<void()>;
void SetUnauthorizedHandler(UnauthorizedCb cb);

// POST /api/v1/devices/register。无鉴权,body 带 s_mac。
// 仅在 NVS 没有 device_secret 时调用,否则后端会按 reset 语义把当前主人踢掉。
bool Register(RegisterResult& out);

// 核心轮询:上传 telemetry / 拿 state。Bearer 鉴权。
bool Poll(const Telemetry& tel, DeviceState& out);

// 主动 cycle 切组。direction: "next" | "prev"。
bool CycleGroup(const std::string& direction, DeviceState& out);

// 选指定 gid。
bool SelectGroup(const std::string& gid, DeviceState& out);

// 拉 manifest。if_none_match 非空 → 服务器若 etag 一致回 304,
// 此时 not_modified=true、out 不动、函数 return true。
bool GetManifest(const std::string& group_id, const std::string& if_none_match, Manifest& out, bool& not_modified);

// 拉 content binary。GET /api/v1/contents/:contentId/image|audio。
bool DownloadContentImage(const std::string& content_id, const std::string& if_none_match,
                          std::vector<uint8_t>& out, bool& not_modified);
bool DownloadContentAudio(const std::string& content_id, const std::string& if_none_match,
                          std::vector<uint8_t>& out, bool& not_modified);

}  // namespace api
