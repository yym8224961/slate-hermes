import { resolve } from 'node:path';
import type { FontFamily } from './types';

// backend/fonts/ 目录：字体文件已随代码库一起入库，本地和 Docker 均使用此目录。
// 路径从本文件向上 4 级：layout-engine/ → widgets/ → modules/ → src/ → backend/
const FONTS_DIR = resolve(import.meta.dirname, '../../../../fonts');

/** 生成 SVG <style> @font-face 块，将 resvg 字体解析锁定到 backend/fonts/ 目录下的文件。
 *  结果缓存：进程生命周期内只计算一次。
 */
let _fontFaceCache: string | undefined;
export function fontFaceStyle(): string {
  if (_fontFaceCache !== undefined) return _fontFaceCache;

  const fonts: Array<{ family: string; file: string; weight?: string }> = [
    { family: 'Noto Sans SC', file: 'NotoSansSC-Regular.otf' },
    { family: 'Noto Sans SC', file: 'NotoSansSC-Bold.otf', weight: 'bold' },
    { family: 'Noto Serif SC', file: 'NotoSerifSC-Regular.otf' },
    { family: 'Noto Serif SC', file: 'NotoSerifSC-Bold.otf', weight: 'bold' },
    { family: 'DejaVu Sans Mono', file: 'DejaVuSansMono.ttf' },
    { family: 'DejaVu Sans Mono', file: 'DejaVuSansMono-Bold.ttf', weight: 'bold' },
  ];

  const faces = fonts.map(({ family, file, weight = 'normal' }) => {
    const p = resolve(FONTS_DIR, file);
    return `@font-face{font-family:"${family}";src:url("file://${p}");font-weight:${weight};}`;
  });

  _fontFaceCache = `<style>${faces.join('')}</style>`;
  return _fontFaceCache;
}

/**
 * 字体 family → SVG font-family 串。
 */
export function fontFamily(f: FontFamily | undefined): string {
  switch (f) {
    case 'serif':
      return '"Noto Serif SC", serif';
    case 'mono':
      return '"DejaVu Sans Mono", monospace';
    case 'sans':
    default:
      return '"Noto Sans SC", sans-serif';
  }
}

/**
 * 根据 fontSize 估算行高（含上下间距）。
 * librsvg 渲染时 baseline 偏 line-height 中线；我们用 1.25 倍作为流式布局的 advance。
 */
export function lineHeight(size: number): number {
  return Math.round(size * 1.25);
}

/**
 * 把字符串里 SVG/XML 特殊字符转义，防止用户输入破坏 SVG 结构。
 * 不做 HTML 实体化（< → &lt; 这种就够）。
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
