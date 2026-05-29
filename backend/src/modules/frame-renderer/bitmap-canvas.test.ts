import { describe, expect, it } from 'bun:test';
import { BitmapCanvas, PIXEL_WHITE } from './bitmap-canvas';

describe('BitmapCanvas', () => {
  it('packs partial trailing bytes for non-8-divisible canvas sizes', () => {
    const canvas = new BitmapCanvas(3, 3);
    canvas.setPixel(2, 2, PIXEL_WHITE);

    const raw = canvas.toRaw1bpp();

    expect(raw.length).toBe(2);
    expect(raw[1]).toBe(0x80);
  });

  it('clips horizontal and vertical lines before writing pixels', () => {
    const canvas = new BitmapCanvas(4, 4);

    canvas.drawHLine(-2, 1, 5, PIXEL_WHITE);
    canvas.drawVLine(3, -1, 3, PIXEL_WHITE);

    const raw = canvas.toRaw1bpp();
    expect([...raw]).toEqual([0x1f, 0x00]);
  });
});
