// Mono Press 颜色常量，与 global.css 中的 design tokens 保持同步。
//
// Canvas 渲染无法使用 CSS 变量，因此需要硬编码 RGB 值。
// 修改颜色时请同步更新 global.css 中的 --color-paper 和 --color-ink。

/** 纸本底色 #f5f3ed */
export const PAPER_RGB = [0xf5, 0xf3, 0xed] as const;

/** 墨色 #14110d */
export const INK_RGB = [0x14, 0x11, 0x0d] as const;

/** 纸本底色 CSS 字符串 */
export const PAPER_HEX = '#f5f3ed';

/** 墨色 CSS 字符串 */
export const INK_HEX = '#14110d';
