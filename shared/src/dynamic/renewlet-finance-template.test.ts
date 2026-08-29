import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DashboardTemplate, dashboardTemplateUsesFullCanvas } from './templates';

const monthlyTemplate = readJSON('monthly-cashflow-template.json');
const monthlyInitial = readJSON('monthly-cashflow-initial-data.json') as {
  version: number;
  data: { monthly: Record<string, unknown> };
};
const recentTemplate = readJSON('recent-expenses-template.json');
const recentInitial = readJSON('recent-expenses-initial-data.json') as {
  version: number;
  data: { recent: Record<string, unknown> };
};

describe('Renewlet finance Slate templates', () => {
  it('ships two valid full-canvas 400 by 300 templates', () => {
    const monthly = DashboardTemplate.parse(monthlyTemplate);
    const recent = DashboardTemplate.parse(recentTemplate);

    expect(monthly.name).toBe('Renewlet 本月现金流');
    expect(recent.name).toBe('Renewlet 最近消费');
    expect(dashboardTemplateUsesFullCanvas(monthly)).toBe(true);
    expect(dashboardTemplateUsesFullCanvas(recent)).toBe(true);
    expect(monthly.blocks.every(blockWithinCanvas)).toBe(true);
    expect(recent.blocks.every(blockWithinCanvas)).toBe(true);
  });

  it('keeps the monthly net cashflow hero separate from occurred transaction metrics', () => {
    const monthly = DashboardTemplate.parse(monthlyTemplate);
    const serialized = JSON.stringify(monthly);

    expect(serialized).toContain('{monthly.net_amount_text}');
    expect(serialized).toContain('{monthly.expense_amount}');
    expect(serialized).toContain('{monthly.income_amount}');
    expect(serialized).toContain('{monthly.refund_amount}');
    expect(serialized).not.toContain('subscription');
    expect(serialized).not.toContain('预计');
    expect(monthlyInitial.version).toBe(1);
    expect(monthlyInitial.data.monthly).toMatchObject({
      currency: 'CNY',
      net_amount_text: 'CNY +1,485.14',
      show_empty_expenses: false,
    });
  });

  it('locks five recent-expense rows and an explicit empty state', () => {
    const recent = DashboardTemplate.parse(recentTemplate);
    const rowBindings = recent.blocks.flatMap((block) =>
      block.type === 'text' && /^\{recent\.row[1-5]\.merchant\}$/.test(block.value)
        ? [block.value]
        : []
    );

    expect(rowBindings).toEqual([
      '{recent.row1.merchant}',
      '{recent.row2.merchant}',
      '{recent.row3.merchant}',
      '{recent.row4.merchant}',
      '{recent.row5.merchant}',
    ]);
    expect(JSON.stringify(recent)).toContain('{recent.show_empty}');
    expect(recentInitial.version).toBe(1);
    expect(recentInitial.data.recent).toMatchObject({
      summary_text: '最近 5 笔 · 按发生时间倒序',
      show_empty: false,
      source_text: '来源 Renewlet',
    });
  });
});

function readJSON(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../tools/renewlet-finance-dashboard/templates/${name}`, import.meta.url),
      'utf8'
    )
  );
}

function blockWithinCanvas(
  block: ReturnType<typeof DashboardTemplate.parse>['blocks'][number]
): boolean {
  if ('x' in block)
    return block.x >= 0 && block.y >= 0 && block.x + block.w <= 400 && block.y + block.h <= 300;
  return block.x1 >= 0 && block.x2 < 400 && block.y1 >= 0 && block.y2 < 300;
}
