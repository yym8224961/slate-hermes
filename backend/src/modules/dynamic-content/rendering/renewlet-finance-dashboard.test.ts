import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DashboardTemplate, FRAME_BYTES, FRAME_WIDTH, type DashboardTemplateT } from 'shared';
import { DynamicFrameRendererService } from './dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './fonts/dynamic-frame-font.service';

const monthlyTemplate = loadTemplate('monthly-cashflow-template.json');
const monthlyData = loadInitial('monthly-cashflow-initial-data.json');
const recentTemplate = loadTemplate('recent-expenses-template.json');
const recentData = loadInitial('recent-expenses-initial-data.json');
const renderer = new DynamicFrameRendererService(new DynamicFrameFontService());

describe('Renewlet finance dashboard rendering', () => {
  it('renders the monthly cashflow hero as a full-width black ledger header', async () => {
    const frame = await render(monthlyTemplate, monthlyData);

    expect(frame.byteLength).toBe(FRAME_BYTES);
    expect(countBlack(frame, 0, 0, 1, 118)).toBe(118);
    expect(countBlack(frame, 399, 0, 1, 118)).toBe(118);
    expect(isBlack(frame, 0, 118)).toBe(false);
    expect(countBlack(frame, 14, 128, 372, 1)).toBe(372);
    expect(countBlack(frame, 137, 136, 1, 46)).toBe(46);
    expect(countBlack(frame, 261, 136, 1, 46)).toBe(46);
  });

  it('renders the recent-expense ledger with five bounded rows and a footer divider', async () => {
    const frame = await render(recentTemplate, recentData);

    expect(frame.byteLength).toBe(FRAME_BYTES);
    expect(countBlack(frame, 0, 0, 1, 62)).toBe(62);
    expect(countBlack(frame, 399, 0, 1, 62)).toBe(62);
    expect(countBlack(frame, 14, 88, 372, 1)).toBe(372);
    expect(countBlack(frame, 14, 266, 372, 1)).toBe(372);
    expect(countBlack(frame, 0, 295, 400, 5)).toBe(0);
  });

  it('switches the recent page to its empty state without retaining sample rows', async () => {
    const emptyData = structuredClone(recentData) as {
      recent: Record<string, unknown> & {
        show_empty: boolean;
        row1: { visible: boolean };
        row2: { visible: boolean };
        row3: { visible: boolean };
        row4: { visible: boolean };
        row5: { visible: boolean };
      };
    };
    emptyData.recent.show_empty = true;
    for (const key of ['row1', 'row2', 'row3', 'row4', 'row5'] as const) {
      emptyData.recent[key].visible = false;
    }
    const populated = await render(recentTemplate, recentData);
    const empty = await render(recentTemplate, emptyData);

    expect(empty).not.toEqual(populated);
    expect(countBlack(empty, 14, 98, 372, 154)).toBeLessThan(
      countBlack(populated, 14, 98, 372, 154)
    );
  });
});

function loadTemplate(name: string): DashboardTemplateT {
  return DashboardTemplate.parse(
    JSON.parse(
      readFileSync(
        new URL(
          `../../../../../tools/renewlet-finance-dashboard/templates/${name}`,
          import.meta.url
        ),
        'utf8'
      )
    )
  );
}

function loadInitial(name: string): Record<string, unknown> {
  const envelope = JSON.parse(
    readFileSync(
      new URL(`../../../../../tools/renewlet-finance-dashboard/templates/${name}`, import.meta.url),
      'utf8'
    )
  ) as { data: Record<string, unknown> };
  return envelope.data;
}

async function render(
  template: DashboardTemplateT,
  data: Record<string, unknown>
): Promise<Buffer> {
  return renderer.render({
    type: 'dashboard',
    frameName: template.name ?? 'Renewlet 财务',
    config: { type: 'dashboard', template: { kind: 'custom', template } },
    data,
    renderedAt: new Date('2026-08-29T17:15:00.000Z'),
  });
}

function countBlack(frame: Buffer, x: number, y: number, w: number, h: number): number {
  let black = 0;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      if (isBlack(frame, xx, yy)) black += 1;
    }
  }
  return black;
}

function isBlack(frame: Buffer, x: number, y: number): boolean {
  const bytesPerRow = FRAME_WIDTH >> 3;
  const byte = frame[y * bytesPerRow + (x >> 3)]!;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}
