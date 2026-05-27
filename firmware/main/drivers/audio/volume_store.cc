#include "volume_store.h"

#include "nvs_schema.h"
#include "nvs_store.h"

namespace {
int Clamp(int level) {
    if (level < 0)
        return 0;
    if (level > vol::kMax)
        return vol::kMax;
    return level;
}
}  // namespace

namespace vol {

int Get() {
    return GetAlbum();
}

void Set(int level) {
    SetAlbum(level);
}

int GetAlbum() {
    int8_t v = nvs_store::GetInt8(nvs_schema::kAudio, nvs_schema::audio::kAlbumVol,
                                  static_cast<int8_t>(kDefault));
    if (v < 0 || v > kMax)
        return kDefault;
    return v;
}

void SetAlbum(int level) {
    nvs_store::SetInt8(nvs_schema::kAudio, nvs_schema::audio::kAlbumVol,
                       static_cast<int8_t>(Clamp(level)));
}

int GetXiaozhi() {
    int8_t v = nvs_store::GetInt8(nvs_schema::kAudio, nvs_schema::audio::kChatVol,
                                  static_cast<int8_t>(kDefault));
    if (v < 0 || v > kMax)
        return kDefault;
    return v;
}

void SetXiaozhi(int level) {
    nvs_store::SetInt8(nvs_schema::kAudio, nvs_schema::audio::kChatVol,
                       static_cast<int8_t>(Clamp(level)));
}

int ToCodec(int level) {
    return Clamp(level) * 10;
}

}  // namespace vol
