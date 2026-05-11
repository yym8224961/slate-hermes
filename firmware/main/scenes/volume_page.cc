#include "volume_page.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <esp_log.h>
#include <vector>

#include "../app/event_bus.h"
#include "../app/scene_stack.h"
#include "../audio/audio_player.h"
#include "../audio/volume_store.h"
#include "../display/epd_ssd1683.h"
#include "../ui/theme.h"

namespace {
constexpr char kTag[] = "VolumePage";

constexpr int kBarWidth  = 280;
constexpr int kBarHeight = 24;

// 16 kHz 单声道 16-bit PCM，440 Hz 200 ms 正弦波
std::vector<uint8_t> MakeTestTone() {
    constexpr int   kRate    = 16000;
    constexpr int   kMs      = 200;
    constexpr float kFreq    = 440.0f;
    constexpr int   kSamples = kRate * kMs / 1000;
    std::vector<uint8_t> buf(kSamples * 2);
    for (int i = 0; i < kSamples; ++i) {
        const float t = static_cast<float>(i) / kRate;
        int16_t s = static_cast<int16_t>(0.6f * 32767.0f * std::sin(2.0f * 3.1415926f * kFreq * t));
        buf[2 * i + 0] = static_cast<uint8_t>(s & 0xFF);
        buf[2 * i + 1] = static_cast<uint8_t>((s >> 8) & 0xFF);
    }
    return buf;
}
}  // namespace

VolumePage::VolumePage()  = default;
VolumePage::~VolumePage() = default;

void VolumePage::OnEnter(SceneContext& ctx) {
    if (!ctx.epd->Lock(2000)) return;

    auto* screen = lv_screen_active();
    root_ = lv_obj_create(screen);
    lv_obj_set_size(root_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root_, 0, 0);
    lv_obj_set_style_bg_color(root_, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_clear_flag(root_, LV_OBJ_FLAG_SCROLLABLE);

    status_bar_ = std::make_unique<StatusBar>(root_);
    status_bar_->SetCaption("音量调节");

    // 数值 "6 / 10",大写字号靠居中视觉强调
    value_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(value_label_, &SourceHanSansSC_Regular_slim, 0);
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
    lv_obj_set_style_text_font(hint_label_, &SourceHanSansSC_Regular_slim, 0);
    lv_obj_set_style_text_color(hint_label_, lv_color_black(), 0);
    lv_obj_set_style_text_align(hint_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(hint_label_, "上/下 调节   按确认 返回   长按确认 试听");
    lv_obj_align(hint_label_, LV_ALIGN_BOTTOM_MID, 0, -16);

    level_ = vol::Get();
    RedrawValue();

    lv_refr_now(NULL);
    ctx.epd->Unlock();
    // OnEnter 走 partial:UI ↔ UI 切换 diff 小,EPD 看 diff>=30% 兜底升 full。
    ctx.epd->RequestUrgentPartialRefresh();
}

void VolumePage::OnExit(SceneContext& ctx) {
    if (!ctx.epd->Lock(500)) return;
    status_bar_.reset();
    if (root_) {
        lv_obj_del(root_);
        root_ = nullptr;
    }
    ctx.epd->Unlock();
}

void VolumePage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    switch (e.kind) {
        case UiEventKind::kButtonShort:
            switch (e.u.button.btn) {
                case ButtonId::kUp:
                    if (level_ < vol::kMax) {
                        level_++;
                        vol::Set(level_);
                        AudioPlayer::Get().SetVolume(vol::ToCodec(level_));
                        RedrawValue();
                        SyncRender(ctx);
                    }
                    break;
                case ButtonId::kDown:
                    if (level_ > 0) {
                        level_--;
                        vol::Set(level_);
                        AudioPlayer::Get().SetVolume(vol::ToCodec(level_));
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
            if (e.u.button.btn == ButtonId::kEnter) PlayTestTone(ctx);
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

void VolumePage::SyncRender(SceneContext& ctx) {
    if (!ctx.epd || !ctx.epd->Lock(500)) return;
    lv_refr_now(NULL);
    ctx.epd->Unlock();
    ctx.epd->RequestUrgentPartialRefresh();
}

void VolumePage::PlayTestTone(SceneContext& ctx) {
    if (!ctx.audio) return;
    static std::vector<uint8_t> tone = MakeTestTone();
    ctx.audio->Play(tone.data(), tone.size());
    ESP_LOGI(kTag, "Play test tone: level=%d codec=%d", level_, vol::ToCodec(level_));
}
