#include "volume_page.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "audio_player.h"
#include "epd_ssd1683.h"
#include "event_bus.h"
#include "scene_stack.h"
#include "theme.h"
#include "volume_store.h"
#include "xiaozhi_audio_service.h"

namespace {
constexpr int kBarWidth  = 280;
constexpr int kBarHeight = 24;

// 16 kHz 单声道 16-bit PCM，440 Hz 200 ms 正弦波
std::vector<uint8_t> MakeTestTone() {
    constexpr int        kRate    = 16000;
    constexpr int        kMs      = 200;
    constexpr float      kFreq    = 440.0f;
    constexpr int        kSamples = kRate * kMs / 1000;
    std::vector<uint8_t> buf(kSamples * 2);
    for (int i = 0; i < kSamples; ++i) {
        const float t  = static_cast<float>(i) / kRate;
        int16_t     s  = static_cast<int16_t>(0.6f * 32767.0f * std::sin(2.0f * 3.1415926f * kFreq * t));
        buf[2 * i + 0] = static_cast<uint8_t>(s & 0xFF);
        buf[2 * i + 1] = static_cast<uint8_t>((s >> 8) & 0xFF);
    }
    return buf;
}
}  // namespace

VolumePage::VolumePage(Target target) : target_(target) {
}
VolumePage::~VolumePage() = default;

void VolumePage::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000))
        return;

    root_ = CreateFullscreenRoot();

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption(Caption());
    RefreshStatusBarFromSensors(ctx, *status_bar_);

    // 数值 "6 / 10",大写字号靠居中视觉强调
    value_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(value_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(value_label_, lv_color_black(), 0);
    lv_obj_align(value_label_, LV_ALIGN_CENTER, 0, -32);

    // 进度条:黑色 1px 边框 + 内部填充。线条简洁、EPD 1bpp 锐利。
    bar_track_ = lv_obj_create(root_);
    lv_obj_set_size(bar_track_, kBarWidth, kBarHeight);
    lv_obj_align(bar_track_, LV_ALIGN_CENTER, 0, 4);
    lv_obj_set_style_bg_color(bar_track_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(bar_track_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(bar_track_, lv_color_black(), 0);
    lv_obj_set_style_border_width(bar_track_, 1, 0);
    lv_obj_set_style_radius(bar_track_, 0, 0);
    lv_obj_set_style_pad_all(bar_track_, 0, 0);
    lv_obj_clear_flag(bar_track_, LV_OBJ_FLAG_SCROLLABLE);

    bar_fill_ = lv_obj_create(bar_track_);
    lv_obj_set_size(bar_fill_, 0, kBarHeight - 2);  // 宽度 RedrawValue 算
    lv_obj_set_pos(bar_fill_, 0, 0);
    lv_obj_set_style_bg_color(bar_fill_, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(bar_fill_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(bar_fill_, 0, 0);
    lv_obj_set_style_radius(bar_fill_, 0, 0);
    lv_obj_set_style_pad_all(bar_fill_, 0, 0);
    lv_obj_clear_flag(bar_fill_, LV_OBJ_FLAG_SCROLLABLE);

    hint_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(hint_label_, &Zfull_16, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_label_, target_ == Target::kAlbum ? "上/下 调节   按确认 返回   长按确认 试听"
                                                             : "上/下 调节   按确认 返回");
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -16);

    level_ = (target_ == Target::kAlbum) ? vol::GetAlbum() : vol::GetXiaozhi();
    RedrawValue();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 看 diff>=30% 兜底升 full。
    ctx.epd->RequestUrgentPartialRefresh();
}

void VolumePage::OnExit(SceneContext& ctx) {
    if (dirty_) {
        SaveLevel();
        dirty_ = false;
    }
    DestroyRoot(ctx, root_, [this]() {
        status_bar_.reset();
        bar_track_   = nullptr;
        bar_fill_    = nullptr;
        value_label_ = nullptr;
        hint_label_  = nullptr;
    });
}

void VolumePage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!root_)
        return;
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    if (level_ < vol::kMax) {
                        level_++;
                        dirty_ = true;
                        ApplyLevel();
                        RedrawValue();
                        SyncRender(ctx);
                    }
                    break;
                case ButtonId::kDown:
                    if (level_ > 0) {
                        level_--;
                        dirty_ = true;
                        ApplyLevel();
                        RedrawValue();
                        SyncRender(ctx);
                    }
                    break;
                case ButtonId::kEnter:
                    // 短按确认 = 返回(避免误触发声)。长按 = 试听。
                    ctx.stack->RequestPop();
                    break;
            }
            break;
        case UiEventKind::kButtonLong:
            if (e.u.button.btn == ButtonId::kEnter)
                PlayTestTone(ctx);
            break;
        default:
            break;
    }
}

void VolumePage::RedrawValue() {
    if (value_label_) {
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%d / %d", level_, vol::kMax);
        lv_label_set_text(value_label_, buf);
        lv_obj_align(value_label_, LV_ALIGN_CENTER, 0, -32);
    }
    if (bar_fill_) {
        const int inner = kBarWidth - 2;  // 减 1px 边框两侧
        const int w     = (inner * level_) / vol::kMax;
        lv_obj_set_size(bar_fill_, w, kBarHeight - 2);
    }
}

void VolumePage::ApplyLevel() {
    if (target_ == Target::kAlbum) {
        AudioPlayer::Get().SetVolume(vol::ToCodec(level_));
    } else {
        xiaozhi::AudioService::Get().SetVolume(vol::ToCodec(level_));
    }
}

void VolumePage::SaveLevel() {
    if (target_ == Target::kAlbum) {
        vol::SetAlbum(level_);
    } else {
        vol::SetXiaozhi(level_);
    }
    ApplyLevel();
}

const char* VolumePage::Caption() const {
    return target_ == Target::kAlbum ? "相册音量" : "小智音量";
}

void VolumePage::PlayTestTone(SceneContext& ctx) {
    if (!ctx.audio || target_ != Target::kAlbum)
        return;
    if (test_tone_.empty())
        test_tone_ = MakeTestTone();
    ctx.audio->Play(test_tone_.data(), test_tone_.size());
}
