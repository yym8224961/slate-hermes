import type { BlockRender, LayoutCtx, TextBlock } from '../types';
import { resolveText } from '../field-accessor';
import { escapeXml, fontFamily, lineHeight } from '../fonts';

/**
 * 折行算法（简化版）：按字符宽度估算，到达容器宽度就换行。
 * librsvg 没有 reflow 支持，所以我们必须手动把字符串切成 <tspan>。
 *
 * 字符宽度按字号 × 0.55（西文）/ 字号 × 1.0（中文）估算。e-ink 屏字号都很大，
 * 估算误差不显著；如果换行造成"半字溢出 4px"，用户可以靠改 max_lines 收敛。
 */
function approxCharWidth(ch: string, size: number): number {
  // 中文/日文/韩文 + 全角符号宽度 ≈ 字号；其他按 0.55 倍
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x4e00 || (code >= 0x3000 && code <= 0x33ff)) {
    return size;
  }
  return size * 0.55;
}

function wrapLines(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      curW = 0;
      continue;
    }
    const w = approxCharWidth(ch, fontSize);
    if (curW + w > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

export function renderText(block: TextBlock, ctx: LayoutCtx, containerWidth: number): BlockRender {
  const text = resolveText(ctx, block.field);
  if (!text) return { svg: '', height: 0 };

  const align = block.align ?? 'left';
  const wrap = block.wrap ?? false;
  const maxLines = block.max_lines ?? 99;
  const lh = lineHeight(block.size);

  const lines = wrap ? wrapLines(text, block.size, containerWidth) : text.split('\n');
  const clipped = lines.slice(0, maxLines);

  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const x = align === 'center' ? containerWidth / 2 : align === 'right' ? containerWidth : 0;

  const tspans = clipped
    .map(
      (line, i) =>
        `<tspan x="${x}" dy="${i === 0 ? block.size * 0.85 : lh}">${escapeXml(line)}</tspan>`
    )
    .join('');
  const svg = `<text text-anchor="${anchor}" font-family='${fontFamily(block.font)}' font-size="${block.size}" font-weight="${block.weight ?? 'normal'}" fill="#000">${tspans}</text>`;

  return { svg, height: clipped.length * lh };
}
