import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { DashboardTemplate, dashboardTemplateUsesFullCanvas } from './templates';

const template = JSON.parse(
  readFileSync(
    new URL(
      '../../../tools/slate-quota-collector/templates/slate-opencode-go-dashboard-template.json',
      import.meta.url
    ),
    'utf8'
  )
);
const envelope = JSON.parse(
  readFileSync(
    new URL('../../../tools/slate-quota-collector/templates/initial-opencode-go-data.json', import.meta.url),
    'utf8'
  )
) as { version: number; data: Record<string, unknown> };

describe('OpenCode Go quota template', () => {
  test('is a valid full-canvas 400 by 300 dashboard without a top or bottom spacer', () => {
    const parsed = DashboardTemplate.parse(template);

    expect(dashboardTemplateUsesFullCanvas(parsed)).toBe(true);
    expect(parsed.blocks[0]).toMatchObject({ type: 'rect', x: 0, y: 0, w: 400 });
    expect(
      parsed.blocks.some(
        (block) => block.type === 'text' && block.y === 282 && block.h === 16
      )
    ).toBe(true);
  });

  test('references only fields present in the independent OpenCode Go initial data', () => {
    const parsed = DashboardTemplate.parse(template);
    expect(envelope.version).toBe(1);
    expect(envelope.data.opencode_go).toBeDefined();
    expect(envelope.data.codex).toBeUndefined();
    expect(envelope.data.reset_radar).toBeUndefined();
    expect(envelope.data.task_activity).toBeUndefined();

    for (const block of parsed.blocks) {
      for (const candidate of Object.values(block)) {
        if (typeof candidate !== 'string') continue;
        const match = /^\{([a-z0-9_.]+)\}$/.exec(candidate);
        if (!match) continue;
        expect(readPath(envelope.data, match[1])).not.toBeUndefined();
      }
    }
  });
});

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}
