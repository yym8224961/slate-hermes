import { hasGlyph, type BitmapFont } from './bitmap-font';
import { BitmapCanvas } from './bitmap-canvas';

export function wrapText(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string,
  maxWidth: number,
  maxLines: number,
  ellipsis: boolean
): string[] {
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (!source) return [];
  const lines: string[] = [];
  let cur = '';
  for (const ch of source) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    const next = `${cur}${ch}`;
    if (textWidthFallback(font, fallback, next) > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const clipped = lines.slice(0, maxLines).map((line) => filterDrawable(font, fallback, line));
  if (
    ellipsis &&
    clipped.length === maxLines &&
    textWidthFallback(font, fallback, clipped[clipped.length - 1] ?? '') > maxWidth
  ) {
    clipped[clipped.length - 1] = ellipsize(font, fallback, clipped[clipped.length - 1]!, maxWidth);
  } else if (ellipsis && source.length > clipped.join('').length && clipped.length > 0) {
    clipped[clipped.length - 1] = ellipsize(font, fallback, clipped[clipped.length - 1]!, maxWidth);
  }
  return clipped;
}

export function filterDrawable(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string
): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (hasGlyph(font, cp) || (fallback && hasGlyph(fallback, cp))) out += ch;
    else if (ch === ' ') out += ch;
  }
  return out;
}

export function ellipsize(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string,
  maxWidth: number
): string {
  const ell = hasGlyph(font, 0x2026) || (fallback && hasGlyph(fallback, 0x2026)) ? '…' : '.';
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidthFallback(font, fallback, `${chars.slice(0, mid).join('')}${ell}`) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${chars.slice(0, lo).join('')}${ell}`;
}

export function textWidthFallback(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string
): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const glyph = font.glyphs.get(cp) ?? fallback?.glyphs.get(cp);
    if (glyph) w += Math.round(glyph.adv_w / 16);
  }
  return w;
}

export function textVisualHeight(
  font: BitmapFont,
  text: string,
  fallback?: BitmapFont
): number {
  const bounds = textVisualBounds(font, text, fallback);
  return bounds ? bounds.bottom - bounds.top : 0;
}

export function glyphTopOffset(font: BitmapFont, text: string, fallback?: BitmapFont): number {
  return textVisualBounds(font, text, fallback)?.top ?? 0;
}

export function textVisualBounds(
  font: BitmapFont,
  text: string,
  fallback?: BitmapFont
): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const drawFont = hasGlyph(font, cp)
      ? font
      : fallback && hasGlyph(fallback, cp)
        ? fallback
        : null;
    if (!drawFont) continue;
    const glyph = drawFont.glyphs.get(cp);
    if (!glyph) continue;
    const baselineY = drawFont.lineHeight - drawFont.baseLine;
    const glyphTop = baselineY - glyph.ofs_y - glyph.box_h;
    const glyphBottom = glyphTop + glyph.box_h;
    top = Math.min(top, glyphTop);
    bottom = Math.max(bottom, glyphBottom);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

export function textPixelBounds(
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string
): { left: number; right: number; top: number; bottom: number } | null {
  let penX = 0;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const drawFont = hasGlyph(font, cp)
      ? font
      : fallback && hasGlyph(fallback, cp)
        ? fallback
        : null;
    if (!drawFont) {
      penX += Math.max(1, Math.round(font.lineHeight / 2));
      continue;
    }
    const glyph = drawFont.glyphs.get(cp)!;
    const baselineY = drawFont.lineHeight - drawFont.baseLine;
    const glyphLeft = penX + glyph.ofs_x;
    const glyphTop = baselineY - glyph.ofs_y - glyph.box_h;
    left = Math.min(left, glyphLeft);
    right = Math.max(right, glyphLeft + glyph.box_w);
    top = Math.min(top, glyphTop);
    bottom = Math.max(bottom, glyphTop + glyph.box_h);
    penX += Math.round(glyph.adv_w / 16);
  }
  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    Number.isFinite(top) &&
    Number.isFinite(bottom)
    ? { left, right, top, bottom }
    : null;
}

export function drawTextLine(
  c: BitmapCanvas,
  font: BitmapFont,
  fallback: BitmapFont | undefined,
  text: string,
  x: number,
  y: number,
  color: number
): number {
  let penX = x;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const drawFont = hasGlyph(font, cp)
      ? font
      : fallback && hasGlyph(fallback, cp)
        ? fallback
        : null;
    if (!drawFont) {
      penX += Math.max(1, Math.round(font.lineHeight / 2));
      continue;
    }
    const baselineY = y + drawFont.lineHeight - drawFont.baseLine;
    penX += c.drawGlyph(drawFont, cp, penX, baselineY, color);
  }
  return penX - x;
}
