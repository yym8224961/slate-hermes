import { FRAME_WIDTH } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import { textWidth, type BitmapFont } from './fonts/bitmap-font';
import { type DynamicFrameFontService, type FontSet } from './fonts/dynamic-frame-font.service';
import {
  drawTextLine,
  ellipsize,
  filterDrawable,
  textPixelBounds,
  textWidthFallback,
  wrapText,
} from './frame-text-layout';
import { type TextOptions } from './frame-renderer-layout';

export class FrameDrawKit {
  constructor(private readonly fontService: DynamicFrameFontService) {}

  drawBadge(
    c: BitmapCanvas,
    fonts: FontSet,
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    filled: boolean
  ): void {
    if (filled) c.fillRect(x, y, w, h, PIXEL_BLACK);
    else c.strokeRect(x, y, w, h, PIXEL_BLACK);
    const font =
      textWidth(fonts.sans16, label) <= w - 4
        ? fonts.sans16
        : textWidth(fonts.sans12, label) <= w - 4
          ? fonts.sans12
          : fonts.metric12;
    this.drawTextInBox(c, font, label, x, y, w, h, filled ? PIXEL_WHITE : PIXEL_BLACK);
  }

  drawStrongText(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    opts: TextOptions = {}
  ): number {
    const lineGap = opts.lineGap ?? 3;
    const fallback = this.fallbackForFont(font);
    const lines = wrapText(
      font,
      fallback,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      opts.maxLines ?? 1,
      opts.ellipsis ?? false
    );
    let cursorY = y;
    for (const line of lines) {
      const width = textWidthFallback(font, fallback, line);
      const drawX =
        opts.align === 'center'
          ? Math.round(x - width / 2)
          : opts.align === 'right'
            ? x - width
            : x;
      drawTextLine(c, font, fallback, line, drawX, cursorY, opts.color ?? PIXEL_BLACK);
      drawTextLine(c, font, fallback, line, drawX + 1, cursorY, opts.color ?? PIXEL_BLACK);
      cursorY += font.lineHeight + lineGap;
    }
    return lines.length * font.lineHeight + Math.max(0, lines.length - 1) * lineGap;
  }

  drawRule(c: BitmapCanvas, x: number, y: number, w: number, style: 'solid' | 'dashed'): void {
    this.drawRuleColor(c, x, y, w, style, PIXEL_BLACK);
  }

  drawRuleColor(
    c: BitmapCanvas,
    x: number,
    y: number,
    w: number,
    style: 'solid' | 'dashed',
    color: number
  ): void {
    if (style === 'solid') {
      c.drawHLine(x, y, w, color);
      return;
    }
    for (let xx = 0; xx < w; xx += 8) c.drawHLine(x + xx, y, Math.min(4, w - xx), color);
  }

  drawVRule(c: BitmapCanvas, x: number, y: number, h: number, style: 'solid' | 'dashed'): void {
    if (style === 'solid') {
      c.drawVLine(x, y, h, PIXEL_BLACK);
      return;
    }
    for (let yy = 0; yy < h; yy += 8) c.drawVLine(x, y + yy, Math.min(4, h - yy), PIXEL_BLACK);
  }

  drawSparkline(
    c: BitmapCanvas,
    x: number,
    y: number,
    w: number,
    h: number,
    values: number[]
  ): void {
    if (values.length < 2 || w <= 1 || h <= 1) return;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const range = max - min || 1;
    let lastX = x;
    let lastY = y + h - Math.round(((values[0]! - min) / range) * h);
    for (let i = 1; i < values.length; i++) {
      const xx = x + Math.round((w * i) / (values.length - 1));
      const yy = y + h - Math.round(((values[i]! - min) / range) * h);
      c.drawLine(lastX, lastY, xx, yy, PIXEL_BLACK);
      lastX = xx;
      lastY = yy;
    }
  }

  drawText(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    opts: TextOptions = {}
  ): number {
    const lineGap = opts.lineGap ?? 3;
    const fallback = this.fallbackForFont(font);
    const lines = wrapText(
      font,
      fallback,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      opts.maxLines ?? 1,
      opts.ellipsis ?? false
    );
    let cursorY = y;
    for (const line of lines) {
      const width = textWidthFallback(font, fallback, line);
      const drawX =
        opts.align === 'center'
          ? Math.round(x - width / 2)
          : opts.align === 'right'
            ? x - width
            : x;
      drawTextLine(c, font, fallback, line, drawX, cursorY, opts.color ?? PIXEL_BLACK);
      cursorY += font.lineHeight + lineGap;
    }
    return lines.length * font.lineHeight + Math.max(0, lines.length - 1) * lineGap;
  }

  drawTextInBox(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    color: number
  ): void {
    const fallback = this.fallbackForFont(font);
    const line = filterDrawable(font, fallback, text.trim());
    if (!line) return;
    const bounds = textPixelBounds(font, fallback, line);
    if (!bounds) return;
    const drawX = Math.round(x + (w - (bounds.right - bounds.left)) / 2 - bounds.left);
    const drawY = Math.round(y + (h - (bounds.bottom - bounds.top)) / 2 - bounds.top);
    drawTextLine(c, font, fallback, line, drawX, drawY, color);
  }

  drawTextCenteredY(
    c: BitmapCanvas,
    font: BitmapFont,
    text: string,
    x: number,
    centerY: number,
    opts: Omit<TextOptions, 'maxLines' | 'lineGap'> = {}
  ): void {
    const fallback = this.fallbackForFont(font);
    const lines = wrapText(
      font,
      fallback,
      text,
      opts.maxWidth ?? FRAME_WIDTH,
      1,
      opts.ellipsis ?? false
    );
    const line = lines[0];
    if (!line) return;
    const bounds = textPixelBounds(font, fallback, line);
    if (!bounds) return;
    const width = textWidthFallback(font, fallback, line);
    const drawX =
      opts.align === 'center' ? Math.round(x - width / 2) : opts.align === 'right' ? x - width : x;
    const drawY = Math.round(centerY - (bounds.bottom - bounds.top) / 2 - bounds.top);
    drawTextLine(c, font, fallback, line, drawX, drawY, opts.color ?? PIXEL_BLACK);
  }

  ellipsize(font: BitmapFont, text: string, maxWidth: number): string {
    return ellipsize(font, this.fallbackForFont(font), text, maxWidth);
  }

  textWidth(font: BitmapFont, text: string): number {
    return textWidthFallback(font, this.fallbackForFont(font), text);
  }

  fallbackForFont(font: BitmapFont): BitmapFont | undefined {
    return this.fontService.fallbackForFont(font);
  }
}
