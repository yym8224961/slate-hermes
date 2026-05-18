import type { BigNumberBlock, BlockRender, LayoutCtx } from '../types';
import { resolveText } from '../field-accessor';
import { escapeXml, fontFamily, lineHeight } from '../fonts';

export function renderBigNumber(
  block: BigNumberBlock,
  ctx: LayoutCtx,
  containerWidth: number
): BlockRender {
  const value = resolveText(ctx, block.field);
  if (!value && value !== '0') return { svg: '', height: 0 };
  const display = `${value}${block.suffix ?? ''}`;
  const align = block.align ?? 'center';
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const x = align === 'center' ? containerWidth / 2 : align === 'right' ? containerWidth : 0;
  const baseline = block.size * 0.85;
  // big_number 默认走 mono，数字更整齐
  const family = fontFamily(block.font ?? 'mono');
  const svg = `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-family='${family}' font-size="${block.size}" font-weight="bold" fill="#000">${escapeXml(display)}</text>`;
  return { svg, height: lineHeight(block.size) };
}
