#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { FONT_TEST_FONTS, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import {
  DynamicFrameRendererService,
  type DynamicRenderContext,
} from '../src/modules/frame-renderer/dynamic-frame-renderer.service';
import { CalendarDataService } from '../src/modules/dynamic-content/calendar-data.service';
import { DailyCalendarProvider } from '../src/modules/dynamic-content/providers/daily-calendar.provider';

const outDir = process.argv[2] ?? '/private/tmp/slate-render-debug';
const renderedAt = new Date('2026-05-17T04:00:00.000Z');
const tz = 'Asia/Shanghai';

await mkdir(outDir, { recursive: true });

const renderer = new DynamicFrameRendererService();
const calendar = new CalendarDataService();
const daily = new DailyCalendarProvider();

const contexts: DynamicRenderContext[] = [
  {
    type: 'daily_calendar',
    frameName: '日历',
    config: { tz },
    data: asRecord(await daily.fetchData({ type: 'daily_calendar', tz }, { now: renderedAt })),
    renderedAt,
  },
  {
    type: 'month_calendar',
    frameName: '月历',
    config: { tz },
    data: asRecord(calendar.buildCurrentAndNextMonth(renderedAt, tz)),
    renderedAt,
  },
  {
    type: 'weather',
    frameName: '天气',
    config: {
      provider: 'qweather',
      location_id: '101010100',
      location_label: '北京',
      tz,
    },
    data: {
      tempC: 24,
      feelsLikeC: 26,
      humidity: 61,
      pressure: 1008,
      windDisplay: '东南风2级',
      summary: '多云',
      code: 101,
      obsTime: renderedAt.toISOString(),
      updatedAt: renderedAt.toISOString(),
      fc: [
        { label: '今日', text: '多云', tempMin: 18, tempMax: 27, code: 101, val: '多云 18~27°' },
        { label: '明日', text: '小雨', tempMin: 17, tempMax: 24, code: 305, val: '小雨 17~24°' },
        { label: '后天', text: '晴', tempMin: 19, tempMax: 29, code: 100, val: '晴 19~29°' },
      ],
    },
    renderedAt,
  },
  {
    type: 'history_today',
    frameName: '历史',
    config: { tz },
    data: {
      dateLabel: '5 月 17 日',
      line0: '1792 · 纽约证券交易所成立',
      line1: '1865 · 国际电信联盟在巴黎成立',
      line2: '1949 · 中国人民解放军解放武汉三镇',
      line3: '1995 · Java 编程语言正式发布',
      line4: '2008 · 中国商飞公司在上海成立',
    },
    renderedAt,
  },
  {
    type: 'dashboard',
    frameName: '数据看板',
    config: {},
    data: {
      heading: '运营数据',
      subtitle: '今日实时指标',
      metrics: {
        today: '12,480',
        yesterday: '11,932',
        this_week: '+8.6%',
        this_month: '283k',
      },
    },
    renderedAt,
  },
  {
    type: 'dashboard',
    frameName: '数据看板',
    config: {},
    data: {},
    renderedAt,
  },
  ...FONT_TEST_FONTS.map((font) => ({
    type: 'font_test',
    frameName: font.label,
    config: {
      type: 'font_test',
      font_id: font.id,
      invert: false,
    },
    data: null,
    renderedAt,
  })),
];

for (const ctx of contexts) {
  const frame = await renderer.render(ctx);
  const gray = unpack1bpp(frame);
  const png = await sharp(gray, {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
  })
    .png()
    .toBuffer();
  const file = join(outDir, `${debugFileName(ctx)}.png`);
  await writeFile(file, png);
  process.stdout.write(`${file} ${frame.byteLength} bytes\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function debugFileName(ctx: DynamicRenderContext): string {
  if (ctx.type === 'dashboard' && isEmptyDashboardData(ctx.data)) return 'dashboard-empty';
  if (ctx.type !== 'font_test') return ctx.type;
  return `font-test-${String(ctx.config.font_id ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '-')}`;
}

function isEmptyDashboardData(data: Record<string, unknown> | null): boolean {
  if (!data) return true;
  return !data.layout && !isNonEmptyRecord(data.metrics);
}

function unpack1bpp(buf: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT);
  const bpr = FRAME_WIDTH >> 3;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const byte = buf[y * bpr + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      out[y * FRAME_WIDTH + x] = bit ? 255 : 0;
    }
  }
  return out;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  );
}
