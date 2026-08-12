import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DashboardTemplate } from './templates';

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
);

describe('Slate quota custom template', () => {
  it('matches every approved A5 template field', () => {
    expect(template).toEqual({
      version: 1,
      name: 'Codex · OpenCode Go 额度监控',
      blocks: [
        { type: 'rect', x: 0, y: 24, w: 400, h: 28, stroke: false, fill: 'black' },
        {
          type: 'text',
          x: 12,
          y: 30,
          w: 210,
          h: 18,
          value: '{codex.header_left}',
          font_size: 16,
          color: 'white',
        },
        {
          type: 'text',
          x: 224,
          y: 30,
          w: 164,
          h: 18,
          value: '{codex.summary_label}',
          font_size: 16,
          align: 'right',
          color: 'white',
        },
        {
          type: 'progress',
          x: 12,
          y: 55,
          w: 376,
          h: 38,
          label: '{codex.rolling.label}',
          percentage: '{codex.rolling.remaining_percent}',
          value_text: '{codex.rolling.value_text}',
          label_font_size: 16,
          value_font_size: 16,
          bar_height: 14,
        },
        {
          type: 'progress',
          x: 12,
          y: 93,
          w: 376,
          h: 38,
          label: '{codex.weekly.label}',
          percentage: '{codex.weekly.remaining_percent}',
          value_text: '{codex.weekly.value_text}',
          label_font_size: 16,
          value_font_size: 16,
          bar_height: 14,
        },
        { type: 'line', x1: 12, y1: 134, x2: 388, y2: 134, style: 'solid' },
        {
          type: 'text',
          x: 12,
          y: 139,
          w: 210,
          h: 18,
          value: '{codex.footer_left}',
          font_size: 16,
        },
        {
          type: 'text',
          x: 230,
          y: 139,
          w: 158,
          h: 18,
          value: '{codex.footer_right}',
          font_size: 16,
          align: 'right',
        },
        { type: 'rect', x: 0, y: 158, w: 400, h: 28, stroke: false, fill: 'black' },
        {
          type: 'text',
          x: 12,
          y: 164,
          w: 210,
          h: 18,
          value: '{opencode_go.header_left}',
          font_size: 16,
          color: 'white',
        },
        {
          type: 'text',
          x: 224,
          y: 164,
          w: 164,
          h: 18,
          value: '{opencode_go.summary_label}',
          font_size: 16,
          align: 'right',
          color: 'white',
        },
        {
          type: 'progress',
          x: 12,
          y: 189,
          w: 376,
          h: 31,
          label: '{opencode_go.rolling.label}',
          percentage: '{opencode_go.rolling.remaining_percent}',
          value_text: '{opencode_go.rolling.value_text}',
          label_font_size: 16,
          value_font_size: 16,
          bar_height: 14,
        },
        {
          type: 'progress',
          x: 12,
          y: 220,
          w: 376,
          h: 31,
          label: '{opencode_go.weekly.label}',
          percentage: '{opencode_go.weekly.remaining_percent}',
          value_text: '{opencode_go.weekly.value_text}',
          label_font_size: 16,
          value_font_size: 16,
          bar_height: 14,
        },
        {
          type: 'progress',
          x: 12,
          y: 251,
          w: 376,
          h: 31,
          label: '{opencode_go.monthly.label}',
          percentage: '{opencode_go.monthly.remaining_percent}',
          value_text: '{opencode_go.monthly.value_text}',
          label_font_size: 16,
          value_font_size: 16,
          bar_height: 14,
        },
        { type: 'line', x1: 12, y1: 282, x2: 388, y2: 282, style: 'solid' },
        {
          type: 'text',
          x: 12,
          y: 283,
          w: 210,
          h: 17,
          value: '{opencode_go.footer_left}',
          font_size: 16,
        },
        {
          type: 'text',
          x: 230,
          y: 283,
          w: 158,
          h: 17,
          value: '{opencode_go.footer_right}',
          font_size: 16,
          align: 'right',
        },
      ],
    });
  });

  it('keeps the approved A5 geometry', () => {
    const parsed = DashboardTemplate.parse(template);
    const progressBlocks = parsed.blocks.filter((block) => block.type === 'progress');

    expect(parsed.blocks).toHaveLength(17);
    expect(progressBlocks).toHaveLength(5);
    expect(
      progressBlocks.every(
        (block) =>
          block.bar_height === 14 && block.label_font_size === 16 && block.value_font_size === 16
      )
    ).toBe(true);
    expect(
      Math.max(
        ...parsed.blocks
          .filter((block) => 'y' in block)
          .map((block) => ('y' in block ? block.y + block.h : 0))
      )
    ).toBe(300);
  });

  it('ships a valid Slate ingest envelope with a truthful missing Codex window', () => {
    expect(initial).toEqual({
      version: 1,
      data: {
        schema_version: 1,
        generated_at: '2026-08-12T08:30:00Z',
        codex: {
          status: 'ok',
          source_collected_at: '2026-08-12T08:30:00Z',
          header_left: 'CODEX · PROLITE',
          summary_label: '最低剩余 90%',
          rolling: {
            label: '5 小时',
            remaining_percent: 0,
            value_text: '未提供',
            reset_at: null,
          },
          weekly: {
            label: '本周',
            remaining_percent: 90,
            value_text: '剩余 90%',
            reset_at: '2026-08-19T06:06:00+08:00',
          },
          footer_left: '周重置 08-19 06:06',
          footer_right: 'Credits 128.50',
        },
        opencode_go: {
          status: 'ok',
          source_collected_at: '2026-08-12T08:30:00Z',
          header_left: 'OPENCODE GO',
          summary_label: '最低剩余 71%',
          rolling: {
            label: '5 小时',
            remaining_percent: 81,
            value_text: '剩余 81%',
            reset_at: '2026-08-12T18:30:00+08:00',
          },
          weekly: {
            label: '本周',
            remaining_percent: 71,
            value_text: '剩余 71%',
            reset_at: '2026-08-16T10:00:00+08:00',
          },
          monthly: {
            label: '本月',
            remaining_percent: 75,
            value_text: '剩余 75%',
            reset_at: '2026-09-01T00:00:00+08:00',
          },
          footer_left: '下次重置 08-12 18:30',
          footer_right: '余额接续 关闭',
        },
      },
    });
  });
});
