import { describe, expect, it } from 'bun:test';
import { dynamicConfigUsesFullCanvas } from './full-canvas';

describe('dynamicConfigUsesFullCanvas', () => {
  it('accepts only an explicitly full custom dashboard', () => {
    expect(
      dynamicConfigUsesFullCanvas({
        type: 'dashboard',
        refresh_interval_sec: 300,
        template: {
          kind: 'custom',
          template: {
            canvas: 'full',
            blocks: [{ type: 'rect', x: 0, y: 0, w: 400, h: 300, fill: 'white' }],
          },
        },
      })
    ).toBe(true);
  });

  it('keeps content canvases, system dashboards, and missing configs in status-bar mode', () => {
    expect(
      dynamicConfigUsesFullCanvas({
        type: 'dashboard',
        refresh_interval_sec: 300,
        template: {
          kind: 'custom',
          template: {
            canvas: 'content',
            blocks: [{ type: 'rect', x: 0, y: 24, w: 400, h: 276, fill: 'white' }],
          },
        },
      })
    ).toBe(false);
    expect(
      dynamicConfigUsesFullCanvas({
        type: 'dashboard',
        refresh_interval_sec: 300,
        template: { kind: 'system', id: 'ai_usage_stats' },
      })
    ).toBe(false);
    expect(dynamicConfigUsesFullCanvas(undefined)).toBe(false);
  });
});
