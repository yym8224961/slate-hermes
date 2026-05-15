import type { BitmapFont } from './bitmap-font';

export const PIXEL_BLACK = 0;
export const PIXEL_WHITE = 1;

export class BitmapCanvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width = 400, height = 300) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
  }

  clear(color = PIXEL_WHITE): void {
    this.pixels.fill(color ? PIXEL_WHITE : PIXEL_BLACK);
  }

  setPixel(x: number, y: number, color = PIXEL_BLACK): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = color ? PIXEL_WHITE : PIXEL_BLACK;
  }

  drawHLine(x: number, y: number, w: number, color = PIXEL_BLACK): void {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, color);
  }

  drawVLine(x: number, y: number, h: number, color = PIXEL_BLACK): void {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, color);
  }

  fillRect(x: number, y: number, w: number, h: number, color = PIXEL_BLACK): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.setPixel(xx, yy, color);
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, color = PIXEL_BLACK): void {
    this.drawHLine(x, y, w, color);
    this.drawHLine(x, y + h - 1, w, color);
    this.drawVLine(x, y, h, color);
    this.drawVLine(x + w - 1, y, h, color);
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color = PIXEL_BLACK): void {
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  strokeCircle(cx: number, cy: number, r: number, color = PIXEL_BLACK): void {
    let x = r;
    let y = 0;
    let err = 0;
    while (x >= y) {
      this.setPixel(cx + x, cy + y, color);
      this.setPixel(cx + y, cy + x, color);
      this.setPixel(cx - y, cy + x, color);
      this.setPixel(cx - x, cy + y, color);
      this.setPixel(cx - x, cy - y, color);
      this.setPixel(cx - y, cy - x, color);
      this.setPixel(cx + y, cy - x, color);
      this.setPixel(cx + x, cy - y, color);
      y++;
      if (err <= 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  drawGlyph(
    font: BitmapFont,
    codepoint: number,
    x: number,
    baselineY: number,
    color = PIXEL_BLACK
  ): number {
    const glyph = font.glyphs.get(codepoint);
    if (!glyph) return 0;
    const startX = x + glyph.ofs_x;
    const startY = baselineY - glyph.ofs_y - glyph.box_h;
    let bit = glyph.bitmap_index * 8;
    for (let yy = 0; yy < glyph.box_h; yy++) {
      for (let xx = 0; xx < glyph.box_w; xx++) {
        const byte = font.bitmap[bit >> 3] ?? 0;
        const on = (byte & (0x80 >> (bit & 7))) !== 0;
        if (on) this.setPixel(startX + xx, startY + yy, color);
        bit++;
      }
    }
    return Math.round(glyph.adv_w / 16);
  }

  drawText(
    font: BitmapFont,
    text: string,
    x: number,
    baselineY: number,
    color = PIXEL_BLACK
  ): number {
    let penX = x;
    for (const ch of text) {
      penX += this.drawGlyph(font, ch.codePointAt(0)!, penX, baselineY, color);
    }
    return penX - x;
  }

  toRaw1bpp(): Buffer {
    const out = Buffer.alloc((this.width * this.height) / 8);
    for (let i = 0; i < this.pixels.length; i++) {
      if (this.pixels[i]) out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
  }
}
