#include "scenes/settings/pages/confirm_action_page.h"

#include <utility>

#include "events/event_bus.h"
#include "scenes/core/scene_stack.h"
#include "ui/theme.h"

ConfirmActionPage::ConfirmActionPage(std::string name, std::string caption, std::string warning)
    : name_(std::move(name)),
      caption_(std::move(caption)),
      warning_(std::move(warning)) {
}

ConfirmActionPage::~ConfirmActionPage() = default;

void ConfirmActionPage::OnEnter(SceneContext& ctx) {
    if (!EnterSettingsScaffold(ctx, caption_.c_str()))
        return;

    auto* warn = lv_label_create(RootObj());
    lv_obj_set_style_text_font(warn, &Zfull_16, 0);
    lv_obj_set_style_text_color(warn, lv_color_black(), 0);
    lv_obj_set_style_text_align(warn, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_line_space(warn, 8, 0);
    lv_obj_set_width(warn, LV_HOR_RES - 64);
    lv_label_set_long_mode(warn, LV_LABEL_LONG_WRAP);
    lv_label_set_text(warn, warning_.c_str());
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, -8);

    CreateBottomHint("按确认 返回   长按确认 执行");
    FinishSettingsScaffoldEnter(ctx);
}

void ConfirmActionPage::OnExit(SceneContext& ctx) {
    ExitSettingsScaffold(ctx);
}

void ConfirmActionPage::OnEvent(SceneContext& ctx, const UiEvent& e) {
    if (!RootObj())
        return;
    if (e.kind == UiEventKind::kButtonShort && e.u.button.btn == ButtonId::kEnter) {
        ctx.stack->RequestPop();
        return;
    }
    if (e.kind == UiEventKind::kButtonLong && e.u.button.btn == ButtonId::kEnter) {
        Confirm(ctx);
    }
}
