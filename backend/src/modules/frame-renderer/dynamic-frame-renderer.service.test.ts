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
      {
        type: 'hot_list',
        frameName: '微博热榜',
        config: {
          type: 'hot_list',
          source: 'weibo',
          refresh_interval_sec: 600,
        },
        data: {
          source: 'weibo',
          sourceLabel: '微博',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            { rank: 1, title: '大型科技公司发布新一代墨水屏设备', hot: '893万热度' },
            { rank: 2, title: '本周全国多地迎来强降雨天气', hot: '421万热度' },
            { rank: 3, title: '开源社区讨论 TypeScript 新版本迁移策略', hot: '128万热度' },
            { rank: 4, title: '热门电影票房刷新五月纪录', hot: '96万热度' },
            { rank: 5, title: '城市骑行路线成为周末新选择', hot: '42万热度' },
            { rank: 6, title: '人工智能工具进入更多办公流程', hot: '39万热度' },
            { rank: 7, title: '年轻人开始整理家庭数字资产', hot: '31万热度' },
            { rank: 8, title: '假期短途旅行预订量继续增长', hot: '22万热度' },
          ],
        },
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

  it('centers hot-list rank boxes and title glyphs between row rules', async () => {
    const frame = await renderer.render({
      type: 'hot_list',
      frameName: '热榜',
      config: {
        type: 'hot_list',
        source: 'weibo',
        refresh_interval_sec: 600,
      },
      data: {
        source: 'weibo',
        sourceLabel: '微博',
        updatedAt: '2026-05-17T04:00:00.000Z',
        items: [
          { rank: 1, title: '中俄关系迈上新起点' },
          { rank: 2, title: '全球唯一白色野生大熊猫影像公开' },
          { rank: 3, title: '斯凯奇被清仓' },
          { rank: 4, title: '外国博主扎堆中国乡村' },
          { rank: 5, title: '寒潮预警手机只会越来越贵' },
          { rank: 6, title: '歌手首场排名齐豫第一陈楚庆淘汰' },
          { rank: 7, title: '女子捡到金项链发现异常立马报掉' },
          { rank: 8, title: '黑龙江坚决拥护党中央决定' },
        ],
      },
      renderedAt,
    });

    const listTop = 34;
    const rowH = 33;
    const rankX = 20;
    const rankBoxW = 28;
    const titleX = 62;
    const titleW = 318;

    for (let index = 1; index <= 6; index++) {
      const rowY = listTop + index * rowH;
      const previousRuleY = rowY - 1;
      const nextRuleY = rowY + rowH - 1;
      const rowCenter = (previousRuleY + nextRuleY) / 2;
      const scanTop = previousRuleY + 1;
      const scanH = nextRuleY - previousRuleY - 1;

      const rankBounds = blackBounds(frame, rankX, scanTop, rankBoxW, scanH);
      expect(rankBounds).not.toBeNull();
      expect(centerY(rankBounds!)).toBe(rowCenter);

      const titleBounds = blackBounds(frame, titleX, scanTop, titleW, scanH);
      expect(titleBounds).not.toBeNull();
      expect(Math.abs(centerY(titleBounds!) - rowCenter)).toBeLessThanOrEqual(1);
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

function blackBounds(
  frame: Buffer,
  x: number,
  y: number,
  w: number,
  h: number
): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (!isBlack(frame, xx, yy)) continue;
      top = Math.min(top, yy);
      bottom = Math.max(bottom, yy);
    }
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

function centerY(bounds: { top: number; bottom: number }): number {
  return (bounds.top + bounds.bottom) / 2;
}

function isBlack(frame: Buffer, x: number, y: number): boolean {
  const bpr = FRAME_WIDTH >> 3;
  const byte = frame[y * bpr + (x >> 3)]!;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}
