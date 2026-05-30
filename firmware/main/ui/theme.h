#pragma once

// 集中字体 / 颜色 / 间距，避免每个控件自己 LV_FONT_DECLARE。
//
// 字体清单（全固件统一一份中文字体，避免风格不一致）：
//   - Zfull_16           16px Zfull-GB 墨水屏优化位图，GB2312 + 符号。
//                        所有中文显示统一用这个（BootSplash + 状态栏标题）。
//   - Zfull_12           12px Zfull-GB，ASCII 子集，状态栏百分比数字。
//   - font_awesome_14_1  14px FontAwesome 图标，wifi/电池用。
//
// 状态栏 24px 高 = 16px line_height + 上下 4px 边距。

#include <lvgl.h>

#include <font_awesome.h>

LV_FONT_DECLARE(Zfull_16);
LV_FONT_DECLARE(Zfull_12);
LV_FONT_DECLARE(font_awesome_14_1);
LV_FONT_DECLARE(font_awesome_30_1);

namespace theme {
constexpr int kStatusBarHeight = 24;

// 右侧 scrollbar thumb 几何,MenuList 与 DeviceInfoPage 共用。
constexpr int kScrollbarTrackPadTop    = 12;
constexpr int kScrollbarTrackPadBottom = 12;
constexpr int kScrollbarThumbW         = 2;
constexpr int kScrollbarThumbRightPad  = 6;
constexpr int kScrollbarThumbMinH      = 14;

// Settings menu geometry.
constexpr int kMenuRowHeight   = 42;
constexpr int kMenuRowPadLeft  = 32;
constexpr int kMenuRowPadRight = 24;
constexpr int kMenuCursorBarW  = 4;
constexpr int kMenuCursorBarH  = 22;

// Device info page.
constexpr int kDeviceInfoScrollStep = 80;
}  // namespace theme
