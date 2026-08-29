import { describe, expect, it } from 'bun:test';
import { contentUsesFullCanvas } from './content-presenter';

describe('content full-canvas presentation', () => {
  it('marks only custom dashboards that explicitly request the full canvas', () => {
    expect(
      contentUsesFullCanvas({
        dynamicConfig: {
          type: 'dashboard',
          template: {
            kind: 'custom',
            template: {
              version: 1,
              canvas: 'full',
              blocks: [{ type: 'rect', x: 0, y: 0, w: 400, h: 124, fill: 'black' }],
            },
          },
          refresh_interval_sec: 300,
        },
      })
    ).toBe(true);

    expect(
      contentUsesFullCanvas({
        dynamicConfig: {
          type: 'dashboard',
          template: {
            kind: 'custom',
            template: {
              version: 1,
              blocks: [{ type: 'text', x: 0, y: 24, w: 400, h: 20, value: 'safe' }],
            },
          },
          refresh_interval_sec: 300,
        },
      })
    ).toBe(false);

    expect(
      contentUsesFullCanvas({
        dynamicConfig: {
          type: 'dashboard',
          template: { kind: 'system', id: 'ai_usage_stats' },
          refresh_interval_sec: 300,
        },
      })
    ).toBe(false);
  });
});
