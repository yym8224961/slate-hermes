import type { BlockRender, CenteredTextBlock, LayoutCtx } from '../types';
import { resolveText } from '../field-accessor';
import { escapeXml, fontFamily, lineHeight } from '../fonts';

export function renderCenteredText(
  block: CenteredTextBlock,
  ctx: LayoutCtx,
  containerWidth: number
): BlockRender {
  const text = resolveText(ctx, block.field);
  if (!text) {
    return { svg: '', height: 0 };
  }
  const lh = lineHeight(block.size);
  const cx = containerWidth / 2;
  const baseline = block.size * 0.85;
  const svg = `<text x="${cx}" y="${baseline}" text-anchor="middle" font-family='${fontFamily(block.font)}' font-size="${block.size}" font-weight="${block.weight ?? 'normal'}" fill="#000">${escapeXml(text)}</text>`;
  return { svg, height: lh };
}
