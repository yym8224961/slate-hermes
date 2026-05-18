import type { Block, BlockRender, LayoutCtx, DynamicContentLayout } from './types';
import { renderCenteredText } from './blocks/centered-text';
import { renderText } from './blocks/text';
import { renderKeyValue } from './blocks/key-value';
import { renderBigNumber } from './blocks/big-number';
import { renderSeparator } from './blocks/separator';
import { renderVerticalStack } from './blocks/vertical-stack';
import { fontFaceStyle } from './fonts';

/** 分发到具体 block 渲染器。containerWidth 是减去 padding 后的可用宽。 */
export function renderBlock(block: Block, ctx: LayoutCtx, containerWidth: number): BlockRender {
  switch (block.block) {
    case 'centered_text':
      return renderCenteredText(block, ctx, containerWidth);
    case 'text':
      return renderText(block, ctx, containerWidth);
    case 'key_value':
      return renderKeyValue(block, ctx, containerWidth);
    case 'big_number':
      return renderBigNumber(block, ctx, containerWidth);
    case 'separator':
      return renderSeparator(block, containerWidth);
    case 'vertical_stack':
      return renderVerticalStack(block, ctx, containerWidth);
  }
}

/**
 * 渲染完整 dynamic content layout → SVG 字符串。
 * 严格按 layout.size 输出 viewBox；根容器隐式是 vertical_stack（从上往下流式）。
 * 调用方负责把字符串喂给 sharp 或 librsvg。
 */
export function renderLayout(layout: DynamicContentLayout, ctx: LayoutCtx): string {
  const [w, h] = layout.size;
  const padding = layout.padding ?? 0;
  const topOffset = layout.top_offset ?? 0;
  const containerWidth = w - padding * 2;
  const gap = 8;

  const pieces: string[] = [];
  let y = 0;
  for (const child of layout.body) {
    const r = renderBlock(child, ctx, containerWidth);
    if (r.height === 0) continue;
    pieces.push(`<g transform="translate(${padding},${topOffset + y})">${r.svg}</g>`);
    y += r.height + gap;
  }

  // 白底（动态内容模板自带），确保 1bpp dither 时背景为白。
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    fontFaceStyle() +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>` +
    pieces.join('') +
    `</svg>`
  );
}
