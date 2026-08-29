import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardTemplate, FRAME_BYTES, FRAME_WIDTH, type DashboardTemplateT } from 'shared';
import { BITMAP_1BPP_FONT_DIR } from '../../../infra/assets/asset-paths';
import { DynamicFrameRendererService } from './dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './fonts/dynamic-frame-font.service';
import { loadBitmapFont, textWidth, type BitmapFont } from './fonts/bitmap-font';

interface QuotaWindowFixture {
  name: string;
  remaining_percent: number;
  remaining_text: string;
  used_text: string;
  reset_text: string;
  single_one_digit: boolean;
  single_two_digits: boolean;
  single_three_digits: boolean;
  dual_one_digit: boolean;
  dual_two_digits: boolean;
  dual_three_digits: boolean;
}

interface TaskRowFixture {
  visible: boolean;
  normal_visible: boolean;
  stale_visible: boolean;
  state_label: string;
  title: string;
}

interface DashboardFixture {
  schema_version: number;
  generated_at: string;
  codex: unknown;
  quota: {
    single_window: boolean;
    dual_window: boolean;
    date_label: string;
    heading: string;
    primary: QuotaWindowFixture;
    secondary: QuotaWindowFixture;
    message: string;
    credits_visible: boolean;
    credits_text: string;
  };
  reset_radar: {
    signal_percent: number;
    show_probability: boolean;
    probability_text: string;
    show_narrow_gauge: boolean;
    show_wide_gauge: boolean;
    [key: string]: unknown;
  };
  task_activity: {
    row1: TaskRowFixture;
    row2: TaskRowFixture;
    row3: TaskRowFixture;
    show_stale: boolean;
    show_unavailable: boolean;
    [key: string]: unknown;
  };
  footer: {
    show_divider: boolean;
    show_hidden: boolean;
    show_updated: boolean;
    hidden_text: string;
    update_text: string;
  };
}

const template = DashboardTemplate.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../tools/slate-quota-collector/templates/slate-dashboard-template.json',
        import.meta.url
      ),
      'utf8'
    )
  )
);
const initial = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../tools/slate-quota-collector/templates/initial-data.json',
      import.meta.url
    ),
    'utf8'
  )
) as { version: number; data: DashboardFixture };

const fontService = new DynamicFrameFontService();
const renderer = new DynamicFrameRendererService(fontService);
const renderedAt = new Date('2026-08-29T08:30:00Z');

describe('Slate Codex reset-radar rendering', () => {
  it('renders the upstream black quota header from y=0 with no reserved top band', async () => {
    const frame = await render(initial.data);

    expect(frame.byteLength).toBe(FRAME_BYTES);
    expect(frame.byteLength).toBe(15_000);
    expect(countBlack(frame, 0, 0, 1, 124)).toBe(124);
    expect(countBlack(frame, 399, 0, 1, 124)).toBe(124);
    expect(isBlack(frame, 0, 124)).toBe(false);
    expect(isBlack(frame, 399, 124)).toBe(false);
    expect(countBlack(frame, 14, 124, 372, 1)).toBe(372);
    expect(isBlack(frame, 386, 124)).toBe(false);
  });

  it('switches cleanly between the dual-window and single-window quota branches', async () => {
    const single = await render(initial.data);
    const dualData = fixture((data) => {
      data.quota.single_window = false;
      data.quota.dual_window = true;
      data.quota.primary.single_two_digits = false;
      data.quota.primary.dual_two_digits = true;
      data.quota.secondary.name = '30 天';
      data.quota.secondary.remaining_percent = 50;
      data.quota.secondary.remaining_text = '50';
      data.quota.secondary.used_text = '已用 50%';
      data.quota.secondary.reset_text = '重置 20天 0小时 0分';
      data.quota.secondary.dual_two_digits = true;
    });
    const dual = await render(dualData);

    expect(isBlack(dual, 200, 30)).toBe(false);
    expect(isBlack(single, 200, 30)).toBe(true);
    expect(isBlack(dual, 14, 74)).toBe(false);
    expect(isBlack(single, 14, 74)).toBe(true);
    expect(isBlack(single, 14, 82)).toBe(false);
    expect(isBlack(single, 385, 82)).toBe(false);
  });

  it('draws white quota bars with the upstream 2px inset and floor fill width', async () => {
    const frame = await render(initial.data);

    expect(isBlack(frame, 14, 82)).toBe(false);
    expect(isBlack(frame, 385, 82)).toBe(false);
    expect(isBlack(frame, 16, 84)).toBe(false);
    expect(isBlack(frame, 265, 89)).toBe(false);
    expect(isBlack(frame, 266, 84)).toBe(true);
    expect(isBlack(frame, 15, 83)).toBe(true);
  });

  it('renders a 70 percent reset signal as exactly 7 of 10 cells', async () => {
    const frame = await render(initial.data);

    for (let index = 0; index < 10; index++) {
      const cellX = 14 + index * 33;
      expect(countBlack(frame, cellX + 2, 150, 26, 10)).toBe(index < 7 ? 260 : 0);
    }
    expect(countBlack(frame, 14, 168, 372, 1)).toBe(372);
    expect(isBlack(frame, 386, 168)).toBe(false);
  });

  it('renders task rows at the upstream positions and the footer divider at y=270', async () => {
    const frame = await render(initial.data);
    const font = await loadBitmapFont(join(BITMAP_1BPP_FONT_DIR, 'source-han-sans-16-slim.json'));

    expect(hasTextPixels(frame, font, '执行中', 14, 176, 72, 18)).toBe(true);
    expect(hasTextPixels(frame, font, '已中断', 14, 206, 72, 18)).toBe(true);
    expect(hasTextPixels(frame, font, '本轮完成', 14, 236, 72, 18)).toBe(true);
    expect(countBlack(frame, 14, 270, 372, 1)).toBe(372);
    expect(isBlack(frame, 386, 270)).toBe(false);
    expect(countBlack(frame, 0, 296, 400, 4)).toBe(0);
  });

  it('hard-truncates long task titles without drawing an ellipsis', async () => {
    const data = fixture((draft) => {
      draft.task_activity.row1.title = '超长任务标题'.repeat(12);
    });
    const hardFrame = await render(data);
    const ellipsisTemplate = structuredClone(template);
    const row1Title = ellipsisTemplate.blocks.find(
      (block) =>
        block.type === 'text' &&
        block.value === '{task_activity.row1.title}' &&
        block.visible === '{task_activity.row1.normal_visible}'
    );
    if (!row1Title || row1Title.type !== 'text') throw new Error('row1 title block missing');
    row1Title.ellipsis = true;
    const ellipsisFrame = await render(data, ellipsisTemplate);
    const font = await loadBitmapFont(join(BITMAP_1BPP_FONT_DIR, 'source-han-sans-16-slim.json'));

    expect(hasExactTextPixels(hardFrame, font, '…', 92, 176, 294, 16)).toBe(false);
    expect(hasExactTextPixels(ellipsisFrame, font, '…', 92, 176, 294, 16)).toBe(true);
    expect(hardFrame).not.toEqual(ellipsisFrame);
  });
});

function fixture(mutator: (data: DashboardFixture) => void): DashboardFixture {
  const data = structuredClone(initial.data);
  mutator(data);
  return data;
}

async function render(
  data: DashboardFixture,
  dashboardTemplate: DashboardTemplateT = template
): Promise<Buffer> {
  return renderer.render({
    type: 'dashboard',
    frameName: 'Codex 额度与重置雷达',
    config: { type: 'dashboard', template: { kind: 'custom', template: dashboardTemplate } },
    data: data as unknown as Record<string, unknown>,
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

function isBlack(frame: Buffer, x: number, y: number): boolean {
  const bytesPerRow = FRAME_WIDTH >> 3;
  const byte = frame[y * bytesPerRow + (x >> 3)]!;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}

function hasTextPixels(
  frame: Buffer,
  font: BitmapFont,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const target = renderTextMask(font, text);
  for (let yy = y; yy <= y + h - font.lineHeight; yy++) {
    for (let xx = x; xx <= x + w - target.width; xx++) {
      if (matchesTextMask(frame, target, xx, yy)) return true;
    }
  }
  return false;
}

function hasExactTextPixels(
  frame: Buffer,
  font: BitmapFont,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const target = renderTextMask(font, text);
  for (let yy = y; yy <= y + h - font.lineHeight; yy++) {
    for (let xx = x; xx <= x + w - target.width; xx++) {
      if (matchesExactTextMask(frame, target, xx, yy)) return true;
    }
  }
  return false;
}

function renderTextMask(
  font: BitmapFont,
  text: string
): { width: number; height: number; pixels: Uint8Array } {
  const width = textWidth(font, text);
  const height = font.lineHeight;
  const pixels = new Uint8Array(width * height);
  let penX = 0;
  for (const character of text) {
    const glyph = font.glyphs.get(character.codePointAt(0)!);
    if (!glyph) continue;
    const baselineY = font.lineHeight - font.baseLine;
    const startX = penX + glyph.ofs_x;
    const startY = baselineY - glyph.ofs_y - glyph.box_h;
    let bit = glyph.bitmap_index * 8;
    for (let yy = 0; yy < glyph.box_h; yy++) {
      for (let xx = 0; xx < glyph.box_w; xx++) {
        const byte = font.bitmap[bit >> 3] ?? 0;
        if ((byte & (0x80 >> (bit & 7))) !== 0) {
          const px = startX + xx;
          const py = startY + yy;
          if (px >= 0 && py >= 0 && px < width && py < height) pixels[py * width + px] = 1;
        }
        bit += 1;
      }
    }
    penX += Math.round(glyph.adv_w / 16);
  }
  return { width, height, pixels };
}

function matchesTextMask(
  frame: Buffer,
  target: { width: number; height: number; pixels: Uint8Array },
  x: number,
  y: number
): boolean {
  for (let yy = 0; yy < target.height; yy++) {
    for (let xx = 0; xx < target.width; xx++) {
      if (!target.pixels[yy * target.width + xx]) continue;
      if (!isBlack(frame, x + xx, y + yy)) return false;
    }
  }
  return true;
}

function matchesExactTextMask(
  frame: Buffer,
  target: { width: number; height: number; pixels: Uint8Array },
  x: number,
  y: number
): boolean {
  for (let yy = 0; yy < target.height; yy++) {
    for (let xx = 0; xx < target.width; xx++) {
      if (isBlack(frame, x + xx, y + yy) !== Boolean(target.pixels[yy * target.width + xx])) {
        return false;
      }
    }
  }
  return true;
}
