#pragma once

// HTTP client 封装(所有 server 通讯走这里)。
// 单例,Init(server_url, mac) 一次。设备协议无独立 token,server 按
// X-Device-Mac header 识别(详见 backend/src/modules/devices/devices.service.ts)。
//
// 全部端点都挂在 /api/v1/* 下:
//   POST /api/v1/devices                     首次/重启幂等(mac in body)
//   POST /api/v1/me/poll                     主轮询:上传 telemetry / 拿 state
//   POST /api/v1/me/group/next               cycle 下一组
//   POST /api/v1/me/group/prev               cycle 上一组
//   PUT  /api/v1/me/group                    选指定 group(body {id})
//   GET  /api/v1/groups/:gid/manifest        manifest(dual-auth: 设备带 X-Device-Mac)
//   GET  /api/v1/groups/:gid/frames/:seq/image
//   GET  /api/v1/groups/:gid/frames/:seq/audio
//
// 注意:
//   - frame 在 group 内的位置序号叫 sort_order(JSON key)/seq(C++ 字段),
//     与 backend Frame.sortOrder 对齐。
//   - server 不再下发 pending_action 队列;远程重启等控制由 frontend 走别的通道。

#include <string>
#include <vector>

namespace api {

struct DeviceState {
    // 设备信息
    std::string device_id;
    std::string device_name;
    std::string server_time;

    // group:为空表示当前未选组
    bool        has_group         = false;
    std::string group_id;
    std::string group_etag;
    int         frame_count       = 0;
    int         default_frame_seq = 0;
    int         group_sort_order  = 0;
    int         position_current  = 0;
    int         position_total    = 0;

    // 轮询节奏
    int         poll_interval_s   = 60;
};

struct FrameMeta {
    int         seq;            // group 内位置序号(JSON key: sort_order)
    std::string caption;
    std::string image_etag;
    std::string audio_etag;
    int         image_size = 0;
    int         audio_size = 0;
};

struct Manifest {
    std::string            group_id;
    std::string            group_etag;
    int                    default_frame_seq = 0;
    std::vector<FrameMeta> frames;
};

// poll 携带的 telemetry。值为 < 0 / 空字符串 表示不上报该字段(server 不覆盖原值)。
struct Telemetry {
    int         battery_pct       = -1;
    int         rssi_dbm          = 0;     // 0 = 不上报
    std::string fw_version;
    std::string current_group;
    int         current_frame_seq = 0;
};

void Init(const std::string& server_url, const std::string& mac);
void SetServerUrl(const std::string& url);

// POST /api/v1/devices,首次/重启都调,幂等。无需带 mac header(body 里有)。
bool Register(const std::string& name = "");

// 核心轮询:上传 telemetry / 拿 state。
bool Poll(const Telemetry& tel, DeviceState& out);

// 主动 cycle 切组。direction: "next" | "prev"。响应是新 state(已含切到的 group)。
bool CycleGroup(const std::string& direction, DeviceState& out);

// 选指定 gid。
bool SelectGroup(const std::string& gid, DeviceState& out);

// 拉 manifest。if_none_match 非空 → 服务器若 etag 一致回 304,
// 此时 not_modified=true、out 不动、函数 return true。
bool GetManifest(const std::string& group_id, const std::string& if_none_match,
                 Manifest& out, bool& not_modified);

// 拉 frame binary,语义同上。seq 即 manifest.frames[i].seq。
bool DownloadFrameImage(const std::string& group_id, int seq, const std::string& if_none_match,
                        std::vector<uint8_t>& out, bool& not_modified);
bool DownloadFrameAudio(const std::string& group_id, int seq, const std::string& if_none_match,
                        std::vector<uint8_t>& out, bool& not_modified);

}  // namespace api
