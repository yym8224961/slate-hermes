#pragma once

// 音量持久化:NVS namespace "slate.audio"。
// 用户感知是 0-10 档,codec 实际接收 0-100 → ToCodec(v) = v * 10。
// 默认 9 档(=codec 90)。

namespace vol {

constexpr int kDefault = 9;
constexpr int kMax     = 10;

int  GetAlbum();  // 相册音量,0..10,首次读返回 kDefault
void SetAlbum(int level);
int  GetXiaozhi();
void SetXiaozhi(int level);
int  ToCodec(int level);  // level * 10,给 esp_codec_dev_set_out_vol 用

}  // namespace vol
