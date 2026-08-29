import { describe, expect, it } from 'bun:test';
import { DashboardTemplate, FRAME_WIDTH, type DashboardTemplateT } from 'shared';
import { BitmapCanvas, PIXEL_WHITE } from './bitmap-canvas';
import { DynamicFrameRendererService } from './dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './fonts/dynamic-frame-font.service';

const fontService = new DynamicFrameFontService();
const renderer = new DynamicFrameRendererService(fontService);
const renderedAt = new Date('2026-08-12T08:30:00Z');

describe('dashboard frame renderer presentation extensions', () => {
  it('renders 32px and 48px text with the requested bitmap fonts', async () => {
    const template = DashboardTemplate.parse({
      version: 1,
      blocks: [
        { type: 'text', x: 10, y: 30, w: 100, h: 32, value: '92', font_size: 32 },
        { type: 'text', x: 150, y: 80, w: 160, h: 48, value: '61', font_size: 48 },
      ],
    });

    const frame = await render(template, {});
    const fonts = await fontService.getFonts();
    const expected = new BitmapCanvas();
    expected.clear(PIXEL_WHITE);
    expected.drawText(
      fonts.metric32,
      '92',
      10,
      30 + fonts.metric32.lineHeight - fonts.metric32.baseLine
    );
    expected.drawText(
      fonts.metric48,
      '61',
      150,
      80 + fonts.metric48.lineHeight - fonts.metric48.baseLine
    );

    expect(frame).toEqual(expected.toRaw1bpp());
  });

  it('hides blocks for false bindings and renders them for true bindings', async () => {
    const template = DashboardTemplate.parse({
      version: 1,
      blocks: [
        {
          type: 'rect',
          x: 20,
          y: 30,
          w: 20,
          h: 20,
          fill: 'black',
          visible: '{show_primary}',
        },
        {
          type: 'line',
          x1: 60,
          y1: 30,
          x2: 79,
          y2: 30,
          visible: '{show_secondary}',
        },
        {
          type: 'rect',
          x: 100,
          y: 30,
          w: 20,
          h: 20,
          fill: 'black',
          visible: false,
        },
      ],
    });

    const frame = await render(template, { show_primary: true, show_secondary: false });

    expect(countBlack(frame, 20, 30, 20, 20)).toBe(400);
    expect(countBlack(frame, 60, 30, 20, 1)).toBe(0);
    expect(countBlack(frame, 100, 30, 20, 20)).toBe(0);
  });

  it('honors text ellipsis=false instead of forcing truncation marks', async () => {
    const baseBlock = {
      type: 'text' as const,
      x: 10,
      y: 30,
      w: 20,
      h: 32,
      value: '123',
      font_size: 32 as const,
    };
    const withEllipsis = DashboardTemplate.parse({ version: 1, blocks: [baseBlock] });
    const withoutEllipsis = DashboardTemplate.parse({
      version: 1,
      blocks: [{ ...baseBlock, ellipsis: false }],
    });

    const defaultFrame = await render(withEllipsis, {});
    const noEllipsisFrame = await render(withoutEllipsis, {});

    expect(defaultFrame).not.toEqual(noEllipsisFrame);
    expect(countBlack(defaultFrame, 10, 30, 20, 32)).toBeGreaterThan(0);
    expect(countBlack(noEllipsisFrame, 10, 30, 20, 32)).toBeGreaterThan(0);
  });

  it('draws a white quota bar outline and 2px-inset dynamic fill on black', async () => {
    const template = DashboardTemplate.parse({
      version: 1,
      blocks: [
        { type: 'rect', x: 10, y: 40, w: 120, h: 10, fill: 'black', stroke: false },
        {
          type: 'bar',
          x: 10,
          y: 40,
          w: 120,
          h: 10,
          percentage: '{remaining}',
          color: 'white',
        },
      ],
    });

    const frame = await render(template, { remaining: 25 });

    expect(countWhite(frame, 10, 40, 120, 10)).toBe(430);
    expect(isBlack(frame, 10, 40)).toBe(false);
    expect(isBlack(frame, 12, 42)).toBe(false);
    expect(isBlack(frame, 40, 47)).toBe(false);
    expect(isBlack(frame, 41, 42)).toBe(true);
  });

  it.each([
    [0, 0],
    [1, 1],
    [10, 1],
    [11, 2],
    [61, 7],
    [100, 10],
  ])('fills %i percent as %i of 10 segments using ceil', async (percentage, filledCount) => {
    const template = DashboardTemplate.parse({
      version: 1,
      blocks: [
        {
          type: 'segments',
          x: 10,
          y: 24,
          w: 120,
          h: 10,
          percentage: '{signal}',
          count: 10,
          gap: 2,
        },
      ],
    });

    const frame = await render(template, { signal: percentage });
    for (let index = 0; index < 10; index++) {
      const cellX = 11 + index * 12;
      expect(countBlack(frame, cellX + 1, 25, 8, 8)).toBe(index < filledCount ? 36 : 0);
    }
  });
});

async function render(
  template: DashboardTemplateT,
  data: Record<string, unknown>
): Promise<Buffer> {
  return renderer.render({
    type: 'dashboard',
    frameName: 'renderer extensions',
    config: { type: 'dashboard', template: { kind: 'custom', template } },
    data,
    renderedAt,
  });
}

function countBlack(frame: Buffer, x: number, y: number, w: number, h: number): number {
  let black = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (isBlack(frame, xx, yy)) black += 1;
    }
  }
  return black;
}

function countWhite(frame: Buffer, x: number, y: number, w: number, h: number): number {
  return w * h - countBlack(frame, x, y, w, h);
}

function isBlack(frame: Buffer, x: number, y: number): boolean {
  const bytesPerRow = FRAME_WIDTH >> 3;
  const byte = frame[y * bytesPerRow + (x >> 3)]!;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}
