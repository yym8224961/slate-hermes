import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardTemplate, FRAME_BYTES, FRAME_WIDTH } from 'shared';
import { BITMAP_1BPP_FONT_DIR } from '../../../infra/assets/asset-paths';
import { DynamicFrameRendererService } from './dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './fonts/dynamic-frame-font.service';
import { loadBitmapFont, textWidth, type BitmapFont } from './fonts/bitmap-font';

interface QuotaWindowFixture {
  label: string;
  remaining_percent: number;
  value_text: string;
  reset_at: string | null;
}

interface ProviderFixture {
  status: string;
  source_collected_at: string;
  header_left: string;
  summary_label: string;
  rolling: QuotaWindowFixture;
  weekly: QuotaWindowFixture;
  monthly?: QuotaWindowFixture;
  footer_left: string;
  footer_right: string;
}

interface DashboardFixture {
  schema_version: number;
  generated_at: string;
  codex: ProviderFixture;
  opencode_go: ProviderFixture & { monthly: QuotaWindowFixture };
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

const renderer = new DynamicFrameRendererService(new DynamicFrameFontService());
const renderedAt = new Date('2026-08-12T08:30:00Z');

function fixture(mutator: (data: DashboardFixture) => void): DashboardFixture {
  const data = structuredClone(initial.data);
  mutator(data);
  return data;
}

const fixtures: Record<string, DashboardFixture> = {
  normal: fixture((data) => {
    data.codex.status = 'ok';
    data.codex.summary_label = '最低剩余 90%';
    data.opencode_go.status = 'ok';
    data.opencode_go.summary_label = '最低剩余 71%';
  }),
  attention: fixture((data) => {
    data.codex.status = 'attention';
    data.codex.summary_label = '注意 · 剩余 18%';
    data.codex.weekly.remaining_percent = 18;
    data.codex.weekly.value_text = '剩余 18%';
  }),
  exhausted: fixture((data) => {
    data.opencode_go.status = 'exhausted';
    data.opencode_go.summary_label = '额度用尽';
    data.opencode_go.rolling.remaining_percent = 0;
    data.opencode_go.rolling.value_text = '剩余 0%';
  }),
  'missing-codex-window': fixture((data) => {
    data.codex.status = 'ok';
    data.codex.summary_label = '最低剩余 90%';
    data.codex.rolling.remaining_percent = 0;
    data.codex.rolling.value_text = '未提供';
    data.codex.rolling.reset_at = null;
  }),
  'long-plan': fixture((data) => {
    data.codex.status = 'ok';
    data.codex.header_left = 'CODEX · ENTERPRISE ULTRA LONG PLAN NAME';
    data.codex.summary_label = '这是一条需要安全省略的超长状态文案 90%';
  }),
  'single-stale': fixture((data) => {
    data.codex.status = 'stale';
    data.codex.header_left = 'CODEX · 数据过期';
    data.codex.summary_label = '展示上次数据';
  }),
  'both-empty': fixture((data) => {
    data.codex.status = 'unavailable';
    data.codex.summary_label = '无可信数据';
    data.codex.rolling.remaining_percent = 0;
    data.codex.rolling.value_text = '未提供';
    data.codex.weekly.remaining_percent = 0;
    data.codex.weekly.value_text = '未提供';
    data.opencode_go.status = 'unavailable';
    data.opencode_go.summary_label = '无可信数据';
    for (const window of [
      data.opencode_go.rolling,
      data.opencode_go.weekly,
      data.opencode_go.monthly,
    ]) {
      window.remaining_percent = 0;
      window.value_text = '未提供';
    }
  }),
};

describe('Slate quota A5 dashboard rendering', () => {
  it.each(Object.keys(fixtures))('renders %s as 400x300 1bpp', async (fixtureName) => {
    const frame = await render(fixtures[fixtureName]!);

    expect(frame.byteLength).toBe(FRAME_BYTES);
    expect(frame.byteLength).toBe(15_000);
    expect(countBlack(frame, 0, 24, 400, 276)).toBeGreaterThan(500);
    expect(countBlack(frame, 0, 0, 400, 24)).toBe(0);
  });

  it('draws more remaining bar pixels for 81 percent than 21 percent', async () => {
    const high = await renderWithOpenCodeRollingRemaining(81);
    const low = await renderWithOpenCodeRollingRemaining(21);

    expect(countBlack(high, 100, 189, 210, 31)).toBeGreaterThan(countBlack(low, 100, 189, 210, 31));
  });

  it('renders a missing Codex window as an empty bar labeled 未提供, never as 100%', async () => {
    const data = fixtures['missing-codex-window']!;
    expect(data.codex.rolling.remaining_percent).toBe(0);
    expect(data.codex.rolling.value_text).toBe('未提供');
    expect(JSON.stringify(data.codex.rolling)).not.toContain('100');

    const frame = await render(data);
    const font = await loadBitmapFont(join(BITMAP_1BPP_FONT_DIR, 'source-han-sans-16-slim.json'));
    expect(countBlack(frame, 100, 68, 160, 12)).toBe(0);
    expect(hasTextPixels(frame, font, '未提供', 300, 55, 88, 38)).toBe(true);
    expect(hasTextPixels(frame, font, '100%', 300, 55, 88, 38)).toBe(false);
  });

  it('keeps long copy inside the content area and renders the bottom row without cropping', async () => {
    const frame = await render(fixtures['long-plan']!);

    expect(countBlack(frame, 0, 0, 400, 24)).toBe(0);
    expect(countWhite(frame, 222, 30, 2, 16)).toBe(0);
    expect(countBlack(frame, 0, 283, 400, 17)).toBeGreaterThan(20);
  });
});

async function render(data: DashboardFixture): Promise<Buffer> {
  return renderer.render({
    type: 'dashboard',
    frameName: '额度监控',
    config: { type: 'dashboard', template: { kind: 'custom', template } },
    data: data as unknown as Record<string, unknown>,
    renderedAt,
  });
}

function renderWithOpenCodeRollingRemaining(remaining: number): Promise<Buffer> {
  return render(
    fixture((data) => {
      data.opencode_go.rolling.remaining_percent = remaining;
      data.opencode_go.rolling.value_text = `剩余 ${remaining}%`;
    })
  );
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
