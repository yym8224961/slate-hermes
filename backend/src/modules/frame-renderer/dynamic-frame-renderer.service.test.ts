import { describe, expect, it } from 'bun:test';
import { FONT_TEST_FONTS, FRAME_BYTES, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import {
  DynamicFrameRendererService,
  type DynamicRenderContext,
} from './dynamic-frame-renderer.service';

const renderer = new DynamicFrameRendererService();
const renderedAt = new Date('2026-05-17T04:00:00.000Z');

describe('DynamicFrameRendererService', () => {
  it('renders dynamic frames as nonblank 400x300 1bpp images', async () => {
    const contexts: DynamicRenderContext[] = [
      {
        type: 'daily_calendar',
        frameName: '日历',
        config: { tz: 'Asia/Shanghai' },
        data: {
          year: '2026',
          month: '5',
          day: '17',
          weekdayCN: '星期日',
          lunarDate: '农历四月初一',
          ganzhiYear: '丙午年',
          ganzhiMonth: '癸巳月',
          ganzhiDay: '辛卯日',
          nextSolarTerm: '小满',
          nextSolarTermDays: 4,
          yi: ['祭祀', '祈福', '求嗣', '开光'],
          ji: ['入宅', '修造', '安门', '伐木'],
        },
        renderedAt,
      },
      {
        type: 'month_calendar',
        frameName: '月历',
        config: { tz: 'Asia/Shanghai' },
        data: {
          calendar: {
            months: {
              '2026-05': {
                days: {
                  '2026-05-01': { lunar_date: '农历三月十五' },
                  '2026-05-05': { solar_term: '立夏', lunar_date: '农历三月十九' },
                  '2026-05-17': { lunar_date: '农历四月初一' },
                  '2026-05-21': { solar_term: '小满', lunar_date: '农历四月初五' },
                },
              },
            },
          },
        },
        renderedAt,
      },
      {
        type: 'weather',
        frameName: '天气',
        config: { location_label: '北京' },
        data: {
          tempC: 24,
          feelsLikeC: 26,
          humidity: 61,
          windDisplay: '东南风2级',
          summary: '多云',
          code: 101,
          fc: [
            { label: '今日', text: '多云', tempMin: 18, tempMax: 27, code: 101 },
            { label: '明日', text: '小雨', tempMin: 17, tempMax: 24, code: 305 },
            { label: '后天', text: '晴', tempMin: 19, tempMax: 29, code: 100 },
          ],
        },
        renderedAt,
      },
      {
        type: 'history_today',
        frameName: '历史',
        config: { tz: 'Asia/Shanghai' },
        data: {
          dateLabel: '5 月 17 日',
          items: [
            { year: '1792', display: '纽约证券交易所成立，现代金融市场制度逐步成形' },
            { year: '1865', display: '国际电信联盟在巴黎成立，推动全球通信协作' },
            { year: '1949', display: '中国人民解放军解放武汉三镇，华中局势改变' },
            { year: '1995', display: 'Java 编程语言正式发布，互联网软件生态扩张' },
            { year: '2008', display: '中国商飞公司在上海成立，国产大飞机项目提速' },
          ],
        },
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: '数据',
        config: {},
        data: {
          heading: '运营数据',
          subtitle: '今日实时指标',
          metrics: { today: '12,480', yesterday: '11,932', this_week: '+8.6%', this_month: '283k' },
        },
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: '布局数据',
        config: {},
        data: {
          heading: '布局数据',
          data: { label: '销售额', value: '128k', trend: [3, 8, 5, 13, 21] },
          layout: {
            version: 1,
            heading: '布局数据',
            blocks: [
              {
                type: 'metric',
                x: 24,
                y: 72,
                w: 170,
                h: 80,
                label: '{label}',
                value: '{value}',
                sparkline: '{trend}',
              },
              { type: 'sparkline', x: 220, y: 82, w: 130, h: 58, values: '{trend}' },
              { type: 'line', x1: 24, y1: 166, x2: 360, y2: 166, style: 'dashed' },
              { type: 'rect', x: 220, y: 188, w: 80, h: 42, stroke: true, fill: 'none' },
            ],
          },
        },
        renderedAt,
      },
      {
        type: 'font_test',
        frameName: '字体测试',
        config: {
          type: 'font_test',
          font_id: 'unifont_16',
          invert: false,
        },
        data: null,
        renderedAt,
      },
    ];

    for (const ctx of contexts) {
      const frame = await renderer.render(ctx);
      expect(frame.byteLength).toBe(FRAME_BYTES);
      const stats = countPixels(frame);
      expect(stats.black).toBeGreaterThan(120);
      expect(stats.white).toBeGreaterThan(120);
    }
  });

  it('renders every font-test catalog entry', async () => {
    for (const font of FONT_TEST_FONTS) {
      const frame = await renderer.render({
        type: 'font_test',
        frameName: font.label,
        config: {
          type: 'font_test',
          font_id: font.id,
          invert: false,
        },
        data: null,
        renderedAt,
      });
      expect(frame.byteLength).toBe(FRAME_BYTES);
      const stats = countPixels(frame);
      expect(stats.black).toBeGreaterThan(80);
      expect(stats.white).toBeGreaterThan(80);
    }
  });
});

function countPixels(frame: Buffer): { black: number; white: number } {
  let black = 0;
  let white = 0;
  const bpr = FRAME_WIDTH >> 3;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const byte = frame[y * bpr + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      if (bit) white++;
      else black++;
    }
  }
  return { black, white };
}
