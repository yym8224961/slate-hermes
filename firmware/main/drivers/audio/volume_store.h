#pragma once

// 音量持久化:NVS namespace "slate.audio"。
// 用户感知是 0-10 档,codec 实际接收 0-100 → ToCodec(v) = v * 10。
// 默认 6 档(=codec 60),省电+不刺耳的折中。

namespace vol {

constexpr int kDefault = 6;
constexpr int kMax     = 10;

int  Get();               // 相册音量,0..10,首次读返回 kDefault
void Set(int level);      // 写相册音量
int  GetAlbum();          // 同 Get()
void SetAlbum(int level);
int  GetXiaozhi();
void SetXiaozhi(int level);
int  ToCodec(int level);  // level * 10,给 esp_codec_dev_set_out_vol 用

}  // namespace vol
