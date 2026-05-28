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
});
