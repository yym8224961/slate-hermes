#pragma once

// 集中字体 / 颜色 / 间距，避免每个 widget 自己 LV_FONT_DECLARE。
//
// 字体清单（全固件统一一份中文字体，避免风格不一致）：
//   - SourceHanSansSC_Regular_slim   16px Regular 1bpp，GB2312 6763 汉字 ~2.16 MB。
//                                    所有中文显示统一用这个（BootSplash + 状态栏 caption）。
//                                    1bpp 字模在 EPD 上比 4bpp 抗锯齿二值化干净不少。
//   - font_awesome_14_1              14px FontAwesome 图标(xiaozhi-fonts 提供)，wifi/电池用。
//
// 像素字体:
//   - FusionPixel_12    12px 像素体，ASCII 子集 ~18 KB，用于状态栏百分比数字。
//
// 状态栏 24px 高 = 16px line_height + 上下 4px 边距。

#include <lvgl.h>

#include <font_awesome.h>

LV_FONT_DECLARE(SourceHanSansSC_Regular_slim);
LV_FONT_DECLARE(font_awesome_14_1);
LV_FONT_DECLARE(FusionPixel_12);

namespace theme {
constexpr int kStatusBarHeight = 24;

// 右侧 scrollbar thumb 几何,MenuList 与 DeviceInfoPage 共用。
constexpr int kThumbW        = 2;
constexpr int kThumbRightPad = 6;
constexpr int kThumbMinH     = 14;
}  // namespace theme
