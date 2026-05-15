import type { BlockRender, KeyValueBlock, LayoutCtx } from '../types';
import { resolveText } from '../field-accessor';
import { escapeXml, fontFamily, lineHeight } from '../fonts';

/**
 * key_value：每行 label 左对齐、value 右对齐，中间细虚线/留白。
 * 行间距 = fontSize * 1.4（比正文略松，强化"对照表"感）。
 * label 支持静态字符串（label）或从 ctx 动态取值（label_field）。
 * 值为空的行自动跳过，height 只计算实际渲染的行数，行间不留空洞。
 */
export function renderKeyValue(
  block: KeyValueBlock,
  ctx: LayoutCtx,
  containerWidth: number
): BlockRender {
  const size = block.size ?? 16;
  const lh = lineHeight(size) + 2;
  const family = fontFamily(block.font);

  const svgParts: string[] = [];
  let count = 0;

  for (const item of block.items) {
    const value = resolveText(ctx, item.field);
    if (!value && value !== '0') continue; // 跳过没有值的行
    const label = item.label ?? resolveText(ctx, item.label_field ?? '');
    const display = `${value}${item.suffix ?? ''}`;
    const y = size * 0.85 + count * lh;
    svgParts.push(
      `<text x="0" y="${y}" font-family='${family}' font-size="${size}" fill="#000">${escapeXml(label)}</text>` +
        `<text x="${containerWidth}" y="${y}" text-anchor="end" font-family='${family}' font-size="${size}" font-weight="bold" fill="#000">${escapeXml(display)}</text>`
    );
    count++;
  }

  return {
    svg: svgParts.join(''),
    height: count * lh,
  };
}
