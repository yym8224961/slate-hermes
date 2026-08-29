import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DashboardTemplate, dashboardTemplateUsesFullCanvas } from './templates';

const template = JSON.parse(
  readFileSync(
    new URL(
      '../../../tools/slate-quota-collector/templates/slate-dashboard-template.json',
      import.meta.url
    ),
    'utf8'
  )
);
const initial = JSON.parse(
  readFileSync(
    new URL('../../../tools/slate-quota-collector/templates/initial-data.json', import.meta.url),
    'utf8'
  )
) as { version: number; data: Record<string, unknown> };

describe('Slate Codex reset-radar template', () => {
  it('keeps the upstream 55-block geometry on the full 400 by 300 canvas', () => {
    const parsed = DashboardTemplate.parse(template);
    const header = parsed.blocks.find(
      (block) =>
        block.type === 'rect' &&
        block.x === 0 &&
        block.y === 0 &&
        block.w === 400 &&
        block.h === 124
    );
    const rules = parsed.blocks.filter((block) => block.type === 'line');
    const date = parsed.blocks.find(
      (block) => block.type === 'text' && block.value === '{quota.date_label}'
    );
    const dualResetRows = parsed.blocks.flatMap((block) =>
      block.type === 'text' &&
      (block.value === '{quota.primary.reset_text}' ||
        block.value === '{quota.secondary.reset_text}') &&
      block.visible === '{quota.dual_window}'
        ? [block]
        : []
    );
    const quotaMessage = parsed.blocks.find(
      (block) => block.type === 'text' && block.value === '{quota.message}'
    );
    const credits = parsed.blocks.find(
      (block) => block.type === 'text' && block.value === '{quota.credits_text}'
    );
    const staleLabel = parsed.blocks.find(
      (block) => block.type === 'text' && block.value === '{task_activity.stale_label}'
    );

    expect(parsed.name).toBe('Codex 额度与重置雷达');
    expect(dashboardTemplateUsesFullCanvas(parsed)).toBe(true);
    expect(parsed.blocks).toHaveLength(55);
    expect(header).toMatchObject({ stroke: false, fill: 'black' });
    expect(date).toMatchObject({ x: 226, y: 5, w: 160, font_size: 12, align: 'right' });
    expect(dualResetRows).toHaveLength(2);
    expect(dualResetRows.every((block) => block.y === 83)).toBe(true);
    expect(quotaMessage).toMatchObject({ x: 14, y: 97 });
    expect(credits).toMatchObject({ y: 97 });
    expect(staleLabel).toMatchObject({ x: 176, y: 171 });
    expect(rules).toEqual([
      { type: 'line', x1: 14, y1: 124, x2: 385, y2: 124, style: 'solid' },
      { type: 'line', x1: 14, y1: 168, x2: 385, y2: 168, style: 'solid' },
      {
        type: 'line',
        x1: 14,
        y1: 270,
        x2: 385,
        y2: 270,
        style: 'solid',
        visible: '{footer.show_divider}',
      },
    ]);
    expect(
      parsed.blocks.every((block) => !('y' in block) || (block.y >= 0 && block.y + block.h <= 300))
    ).toBe(true);
  });

  it('contains only Codex quota, radar, task activity, and footer bindings', () => {
    const serializedTemplate = JSON.stringify(template);

    expect(serializedTemplate).not.toContain('opencode_go');
    expect(initial.data).not.toHaveProperty('opencode_go');
    expect(initial.data).toHaveProperty('codex');
    expect(initial.data).toHaveProperty('quota');
    expect(initial.data).toHaveProperty('reset_radar');
    expect(initial.data).toHaveProperty('task_activity');
    expect(initial.data).toHaveProperty('footer');
  });

  it('encodes mutually exclusive single-window and dual-window quota layouts', () => {
    const parsed = DashboardTemplate.parse(template);
    const singleBlocks = parsed.blocks.filter(
      (block) => 'visible' in block && block.visible === '{quota.single_window}'
    );
    const dualBlocks = parsed.blocks.filter(
      (block) => 'visible' in block && block.visible === '{quota.dual_window}'
    );
    const largeSingleNumber = singleBlocks.find(
      (block) => block.type === 'text' && block.font_size === 48
    );
    const compactDualNumbers = dualBlocks.filter(
      (block) => block.type === 'text' && block.font_size === 32
    );

    expect(singleBlocks).toHaveLength(5);
    expect(dualBlocks).toHaveLength(12);
    expect(largeSingleNumber).toMatchObject({
      type: 'text',
      x: 14,
      y: 24,
      value: '{quota.primary.remaining_text}',
      ellipsis: false,
    });
    expect(compactDualNumbers).toHaveLength(2);
    expect(compactDualNumbers.map((block) => ('x' in block ? block.x : -1))).toEqual([14, 214]);
  });

  it('uses upstream white quota bars and a 10-cell reset radar', () => {
    const parsed = DashboardTemplate.parse(template);
    const bars = parsed.blocks.filter((block) => block.type === 'bar');
    const gauges = parsed.blocks.filter((block) => block.type === 'segments');

    expect(bars).toEqual([
      expect.objectContaining({
        x: 14,
        y: 82,
        w: 372,
        h: 10,
        color: 'white',
        visible: '{quota.single_window}',
      }),
      expect.objectContaining({
        x: 14,
        y: 74,
        w: 172,
        h: 8,
        color: 'white',
        visible: '{quota.dual_window}',
      }),
      expect.objectContaining({
        x: 214,
        y: 74,
        w: 172,
        h: 8,
        color: 'white',
        visible: '{quota.dual_window}',
      }),
    ]);
    expect(gauges).toEqual([
      expect.objectContaining({
        x: 14,
        y: 148,
        w: 327,
        h: 14,
        count: 10,
        gap: 3,
        visible: '{reset_radar.show_narrow_gauge}',
      }),
      expect.objectContaining({
        x: 16,
        y: 148,
        w: 368,
        h: 14,
        count: 10,
        gap: 2,
        visible: '{reset_radar.show_wide_gauge}',
      }),
    ]);
    expect(initial.data).toHaveProperty('reset_radar.signal_percent', 70);
  });

  it('locks task rows, footer placement, and hard truncation without ellipses', () => {
    const parsed = DashboardTemplate.parse(template);
    const normalTaskY = parsed.blocks.flatMap((block) =>
      block.type === 'text' &&
      block.x === 14 &&
      typeof block.visible === 'string' &&
      block.visible.endsWith('.normal_visible}')
        ? [block.y]
        : []
    );
    const staleTaskY = parsed.blocks.flatMap((block) =>
      block.type === 'text' &&
      block.x === 14 &&
      typeof block.visible === 'string' &&
      block.visible.endsWith('.stale_visible}')
        ? [block.y]
        : []
    );
    const footerRule = parsed.blocks.find(
      (block) => block.type === 'line' && block.visible === '{footer.show_divider}'
    );
    const footerTextY = parsed.blocks.flatMap((block) =>
      block.type === 'text' && block.value.startsWith('{footer.') ? [block.y] : []
    );
    const textBlocks = parsed.blocks.filter((block) => block.type === 'text');

    expect(normalTaskY).toEqual([176, 206, 236]);
    expect(staleTaskY).toEqual([186, 216, 246]);
    expect(footerRule).toMatchObject({ y1: 270, y2: 270, x1: 14, x2: 385 });
    expect(footerTextY).toEqual([279, 279]);
    expect(textBlocks.every((block) => block.ellipsis === false)).toBe(true);
  });

  it('ships a valid single-window initial envelope for a 70 percent active watch', () => {
    expect(initial.version).toBe(1);
    expect(initial.data).toMatchObject({
      schema_version: 1,
      quota: {
        single_window: true,
        dual_window: false,
        primary: { name: '7 天', remaining_percent: 68, single_two_digits: true },
        secondary: { name: '', remaining_percent: 0, dual_two_digits: false },
      },
      reset_radar: {
        status: 'active_watch',
        signal_percent: 70,
        probability_text: '70%',
        show_narrow_gauge: true,
        show_wide_gauge: false,
      },
      task_activity: {
        availability: 'available',
        row1: { normal_visible: true, state_label: '执行中' },
        row2: { normal_visible: true, state_label: '已中断' },
        row3: { normal_visible: true, state_label: '本轮完成' },
      },
      footer: { show_divider: true, hidden_text: '另有 1 项', update_text: '画面更新 16:30' },
    });
    expect(() => DashboardTemplate.parse(template)).not.toThrow();
  });
});
