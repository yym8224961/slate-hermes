import { describe, expect, it } from 'bun:test';
import { DashboardTemplate, dashboardTemplateUsesFullCanvas } from './templates';

describe('dashboard template presentation extensions', () => {
  it('accepts large text, conditional blocks, and a segmented gauge', () => {
    const parsed = DashboardTemplate.parse({
      version: 1,
      canvas: 'full',
      blocks: [
        {
          type: 'text',
          x: 10,
          y: 0,
          w: 100,
          h: 32,
          value: '{quota.remaining}',
          font_size: 32,
          visible: '{quota.single_window}',
          ellipsis: false,
        },
        {
          type: 'text',
          x: 10,
          y: 60,
          w: 140,
          h: 48,
          value: '{quota.hero}',
          font_size: 48,
          visible: true,
        },
        {
          type: 'segments',
          x: 10,
          y: 120,
          w: 380,
          h: 14,
          percentage: '{radar.signal_percent}',
          visible: '{radar.available}',
        },
        {
          type: 'bar',
          x: 10,
          y: 140,
          w: 380,
          h: 10,
          percentage: '{quota.remaining_percent}',
          color: 'white',
        },
      ],
    });

    expect(parsed.blocks[0]).toMatchObject({ type: 'text', font_size: 32, ellipsis: false });
    expect(parsed.blocks[1]).toMatchObject({
      type: 'text',
      font_size: 48,
      visible: true,
      ellipsis: true,
    });
    expect(parsed.blocks[2]).toMatchObject({ type: 'segments', count: 10, gap: 3 });
    expect(parsed.blocks[3]).toMatchObject({ type: 'bar', color: 'white' });
  });

  it('accepts blocks that use the full canvas from y=0', () => {
    const fullCanvas = DashboardTemplate.parse({
      version: 1,
      canvas: 'full',
      blocks: [
        { type: 'rect', x: 0, y: 0, w: 400, h: 300, stroke: false, fill: 'black' },
        { type: 'line', x1: 0, y1: 0, x2: 399, y2: 0 },
      ],
    });
    const statusBarSafe = DashboardTemplate.parse({
      version: 1,
      blocks: [{ type: 'text', x: 0, y: 24, w: 400, h: 20, value: 'safe' }],
    });

    expect(() => DashboardTemplate.parse(fullCanvas)).not.toThrow();
    expect(dashboardTemplateUsesFullCanvas(fullCanvas)).toBe(true);
    expect(dashboardTemplateUsesFullCanvas(statusBarSafe)).toBe(false);
    expect(() =>
      DashboardTemplate.parse({
        version: 1,
        blocks: [{ type: 'text', x: 0, y: 23, w: 100, h: 20, value: 'unsafe' }],
      })
    ).toThrow();
  });

  it('keeps progress labels restricted to supported 12/16 pixel fonts', () => {
    expect(() =>
      DashboardTemplate.parse({
        version: 1,
        blocks: [
          {
            type: 'progress',
            x: 10,
            y: 24,
            w: 380,
            h: 24,
            label: 'quota',
            percentage: 50,
            label_font_size: 32,
          },
        ],
      })
    ).toThrow();
  });

  it('accepts at most 64 blocks to keep custom rendering work bounded', () => {
    const block = {
      type: 'text' as const,
      x: 0,
      y: 24,
      w: 20,
      h: 12,
      value: 'ok',
    };

    expect(
      DashboardTemplate.safeParse({ version: 1, blocks: Array.from({ length: 64 }, () => block) })
        .success
    ).toBe(true);
    expect(
      DashboardTemplate.safeParse({ version: 1, blocks: Array.from({ length: 65 }, () => block) })
        .success
    ).toBe(false);
  });
});
