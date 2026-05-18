import { z } from 'zod';

// 内置动态内容类型清单。每种对应一个服务端 compiler + 设备端基础 block 组合。
export const DynamicType = z.enum([
  'daily_calendar',
  'month_calendar',
  'weather',
  'history_today',
  'dashboard',
  'font_test',
]);
export type DynamicTypeT = z.infer<typeof DynamicType>;

// IANA 时区。前端默认用浏览器 Intl.DateTimeFormat().resolvedOptions().timeZone。
const Tz = z.string().min(1).max(48);

// 各动态内容类型的 config schema。discriminated union 让前后端共用同一份校验。

export const DailyCalendarConfig = z.object({
  type: z.literal('daily_calendar'),
  tz: Tz,
});
export type DailyCalendarConfigT = z.infer<typeof DailyCalendarConfig>;

export const MonthCalendarConfig = z.object({
  type: z.literal('month_calendar'),
  tz: Tz,
});
export type MonthCalendarConfigT = z.infer<typeof MonthCalendarConfig>;

export const WeatherConfig = z.object({
  type: z.literal('weather'),
  tz: Tz,
  provider: z.enum(['qweather']).default('qweather'),
  location_id: z.string().min(1).max(32),
  location_label: z.string().min(1).max(32),
  units: z.enum(['metric', 'imperial']).default('metric'),
});
export type WeatherConfigT = z.infer<typeof WeatherConfig>;

export const HistoryTodayConfig = z.object({
  type: z.literal('history_today'),
  tz: Tz,
});
export type HistoryTodayConfigT = z.infer<typeof HistoryTodayConfig>;

export const DashboardConfig = z.object({
  type: z.literal('dashboard'),
  layout: z.enum(['metrics', 'sparkline']).default('metrics'),
});
export type DashboardConfigT = z.infer<typeof DashboardConfig>;

export const DEFAULT_FONT_TEST_SAMPLE = '墨水屏字体测试 0123456789 ABC abc';
export const LATIN_FONT_TEST_SAMPLE = 'Slate UI 0123456789 ABC abc <> {} []';
export const DISPLAY_FONT_TEST_SAMPLE = '23:59 100% +12.8 -04 ¥128';
export const ICON_FONT_TEST_SAMPLE =
  '\uf240 \uf241 \uf242 \uf243 \uf244 \uf1eb \uf028 \uf001 \uf00c \uf00d \uf011 \uf013 \uf015 \uf03e \uf044 \uf04b \uf04c \uf04d \uf060 \uf061 \uf062 \uf063 \uf071 \uf0f3 \uf3c5 \uf0ac \uf075 \uf007 \uf019 \uf023 \uf084 \uf05a \uf059 \uf058 \uf057 \uf017 \uf110';

export const FontTestFontIdValues = [
  'fusion_pixel_8',
  'fusion_pixel_10',
  'fusion_pixel_12',
  'ark_pixel_10',
  'ark_pixel_12',
  'ark_pixel_16',
  'cubic_11',
  'muzai_pixel_12',
  'unifont_16',
  'noto_sans_sc_12',
  'source_han_sans_sc_16',
  'spleen_5x8',
  'spleen_6x12',
  'spleen_8x16',
  'spleen_12x24',
  'spleen_16x32',
  'spleen_32x64',
  'cozette_13',
  'pixelmplus_10',
  'pixelmplus_12',
  'montserrat_48',
  'font_awesome_14',
  'font_awesome_30',
] as const;

export const FontTestFontId = z.enum(FontTestFontIdValues);
export type FontTestFontIdT = z.infer<typeof FontTestFontId>;

export type FontTestFontKindT = 'cjk' | 'latin' | 'display' | 'icon';

export interface FontTestFontCatalogEntry {
  id: FontTestFontIdT;
  label: string;
  file: string;
  sizePx: number;
  kind: FontTestFontKindT;
  hint: string;
  note: string;
  source: string;
  license: string;
  sampleText: string;
}

export const FONT_TEST_FONTS = [
  {
    id: 'fusion_pixel_8',
    label: 'Fusion Pixel 8',
    file: 'fusion-pixel-8.json',
    sizePx: 8,
    kind: 'cjk',
    hint: '8px CJK',
    note: '泛中日韩像素黑体，小字号密集信息。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'fusion_pixel_10',
    label: 'Fusion Pixel 10',
    file: 'fusion-pixel-10.json',
    sizePx: 10,
    kind: 'cjk',
    hint: '10px CJK',
    note: '泛中日韩像素黑体，适合墨水屏小正文。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'fusion_pixel_12',
    label: 'Fusion Pixel 12',
    file: 'fusion-pixel-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px CJK',
    note: '泛中日韩像素黑体，适合中文正文。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'ark_pixel_10',
    label: 'Ark Pixel 10',
    file: 'ark-pixel-10.json',
    sizePx: 10,
    kind: 'cjk',
    hint: '10px CJK',
    note: '泛中日韩像素黑体，Fusion 的姊妹项目。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'ark_pixel_12',
    label: 'Ark Pixel 12',
    file: 'ark-pixel-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px CJK',
    note: '泛中日韩像素黑体，中号中文测试。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'ark_pixel_16',
    label: 'Ark Pixel 16',
    file: 'ark-pixel-16.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px limited',
    note: '16px release 中文覆盖有限，适合看拉丁/符号和少量汉字。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
    sampleText: '中文 0123456789 ABC abc',
  },
  {
    id: 'cubic_11',
    label: 'Cubic 11',
    file: 'cubic-11.json',
    sizePx: 11,
    kind: 'cjk',
    hint: '11px CJK',
    note: '11x11 中文点阵体，适合紧凑中文。',
    source: 'ACh-K/Cubic-11',
    license: 'OFL-1.1',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'muzai_pixel_12',
    label: 'Muzai Pixel 12',
    file: 'muzai-pixel-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px CJK',
    note: 'k8x12 简体中文补完像素字体。',
    source: 'DWNfonts/MuzaiPixel',
    license: 'Other',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'unifont_16',
    label: 'GNU Unifont 16',
    file: 'unifont-16.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px fallback',
    note: '宽覆盖 fallback 字体，风格粗糙但缺字少。',
    source: 'multitheftauto/unifont',
    license: 'GNU Unifont',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'noto_sans_sc_12',
    label: 'Noto Sans SC 12',
    file: 'noto-sans-sc-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px CJK',
    note: '常规无衬线中文小字号对照组。',
    source: 'googlefonts/noto-cjk',
    license: 'OFL-1.1',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'source_han_sans_sc_16',
    label: 'Source Han Sans SC 16',
    file: 'source-han-sans-16.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px CJK',
    note: '当前生产中文 UI 字体对照组。',
    source: 'adobe-fonts/source-han-sans',
    license: 'OFL-1.1',
    sampleText: DEFAULT_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_5x8',
    label: 'Spleen 5x8',
    file: 'spleen-5x8.json',
    sizePx: 8,
    kind: 'latin',
    hint: '5x8 Latin',
    note: '极小号等宽点阵，适合状态栏英文/数字。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_6x12',
    label: 'Spleen 6x12',
    file: 'spleen-6x12.json',
    sizePx: 12,
    kind: 'latin',
    hint: '6x12 Latin',
    note: '小号等宽点阵，适合密集英文/数字。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_8x16',
    label: 'Spleen 8x16',
    file: 'spleen-8x16.json',
    sizePx: 16,
    kind: 'latin',
    hint: '8x16 Latin',
    note: '经典终端点阵尺寸。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_12x24',
    label: 'Spleen 12x24',
    file: 'spleen-12x24.json',
    sizePx: 24,
    kind: 'latin',
    hint: '12x24 Latin',
    note: '中大号等宽点阵。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_16x32',
    label: 'Spleen 16x32',
    file: 'spleen-16x32.json',
    sizePx: 32,
    kind: 'latin',
    hint: '16x32 Latin',
    note: '大字号等宽点阵。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: DISPLAY_FONT_TEST_SAMPLE,
  },
  {
    id: 'spleen_32x64',
    label: 'Spleen 32x64',
    file: 'spleen-32x64.json',
    sizePx: 64,
    kind: 'latin',
    hint: '32x64 Latin',
    note: '超大号数字/短文本点阵。',
    source: 'fcambus/spleen',
    license: 'BSD-2-Clause',
    sampleText: DISPLAY_FONT_TEST_SAMPLE,
  },
  {
    id: 'cozette_13',
    label: 'Cozette 13',
    file: 'cozette-13.json',
    sizePx: 13,
    kind: 'latin',
    hint: '13px Latin',
    note: '编程向点阵字体，ASCII 细节清晰。',
    source: 'the-moonwitch/Cozette',
    license: 'MIT',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'pixelmplus_10',
    label: 'PixelMplus 10',
    file: 'pixelmplus-10.json',
    sizePx: 10,
    kind: 'latin',
    hint: '10px Latin',
    note: 'M+ bitmap 派生像素字体，小号拉丁对照。',
    source: 'itouhiro/PixelMplus',
    license: 'M+ bitmap',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'pixelmplus_12',
    label: 'PixelMplus 12',
    file: 'pixelmplus-12.json',
    sizePx: 12,
    kind: 'latin',
    hint: '12px Latin',
    note: 'M+ bitmap 派生像素字体，中号拉丁对照。',
    source: 'itouhiro/PixelMplus',
    license: 'M+ bitmap',
    sampleText: LATIN_FONT_TEST_SAMPLE,
  },
  {
    id: 'montserrat_48',
    label: 'Montserrat 48',
    file: 'montserrat-48.json',
    sizePx: 48,
    kind: 'display',
    hint: '48px display',
    note: '大号拉丁数字对照组。',
    source: 'JulietaUla/Montserrat',
    license: 'OFL-1.1',
    sampleText: DISPLAY_FONT_TEST_SAMPLE,
  },
  {
    id: 'font_awesome_14',
    label: 'Font Awesome 14',
    file: 'font-awesome-14.json',
    sizePx: 14,
    kind: 'icon',
    hint: '14px icons',
    note: '设备端已有图标库，小号图标测试。',
    source: 'FortAwesome/Font-Awesome',
    license: 'Font Awesome Free',
    sampleText: ICON_FONT_TEST_SAMPLE,
  },
  {
    id: 'font_awesome_30',
    label: 'Font Awesome 30',
    file: 'font-awesome-30.json',
    sizePx: 30,
    kind: 'icon',
    hint: '30px icons',
    note: '设备端已有图标库，大号图标测试。',
    source: 'FortAwesome/Font-Awesome',
    license: 'Font Awesome Free',
    sampleText: ICON_FONT_TEST_SAMPLE,
  },
] as const satisfies readonly FontTestFontCatalogEntry[];

export const FontTestConfig = z.object({
  type: z.literal('font_test'),
  font_id: FontTestFontId.default('fusion_pixel_12'),
  sample_text: z.string().min(1).max(240).default(DEFAULT_FONT_TEST_SAMPLE),
  layout: z.enum(['specimen', 'paragraph', 'numbers', 'icons']).default('specimen'),
  invert: z.boolean().default(false),
});
export type FontTestConfigT = z.infer<typeof FontTestConfig>;

export const DynamicConfig = z.discriminatedUnion('type', [
  DailyCalendarConfig,
  MonthCalendarConfig,
  WeatherConfig,
  HistoryTodayConfig,
  DashboardConfig,
  FontTestConfig,
]);
export type DynamicConfigT = z.infer<typeof DynamicConfig>;

const DeviceRect = z.object({
  x: z.number().int().min(0).max(399),
  y: z.number().int().min(24).max(299),
  w: z.number().int().min(1).max(400),
  h: z.number().int().min(1).max(276),
});

const BindingText = z.string().min(1).max(160);

export const DashboardLayoutBlock = z.discriminatedUnion('type', [
  DeviceRect.extend({
    type: z.literal('text'),
    value: BindingText,
    size: z.enum(['sm', 'md', 'lg']).default('md'),
    align: z.enum(['left', 'center', 'right']).default('left'),
    weight: z.enum(['normal', 'bold']).default('normal'),
    max_lines: z.number().int().min(1).max(4).default(1),
  }),
  DeviceRect.extend({
    type: z.literal('metric'),
    label: BindingText,
    value: BindingText,
    sparkline: z.union([BindingText, z.array(z.number()).min(2).max(60)]).optional(),
  }),
  DeviceRect.extend({
    type: z.literal('sparkline'),
    values: z.union([BindingText, z.array(z.number()).min(2).max(60)]),
  }),
  z.object({
    type: z.literal('line'),
    x1: z.number().int().min(0).max(399),
    y1: z.number().int().min(24).max(299),
    x2: z.number().int().min(0).max(399),
    y2: z.number().int().min(24).max(299),
    style: z.enum(['solid', 'dashed']).default('solid'),
  }),
  DeviceRect.extend({
    type: z.literal('rect'),
    stroke: z.boolean().default(true),
    fill: z.enum(['none', 'black', 'white']).default('none'),
  }),
]);
export type DashboardLayoutBlockT = z.infer<typeof DashboardLayoutBlock>;

export const DashboardLayout = z
  .object({
    version: z.literal(1).default(1),
    heading: z.string().max(48).optional(),
    blocks: z.array(DashboardLayoutBlock).min(1).max(24),
  })
  .superRefine((layout, ctx) => {
    layout.blocks.forEach((block, i) => {
      if (!('x' in block)) return;
      if (block.x + block.w > 400) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'x + w 超出屏幕宽度 400' });
      }
      if (block.y + block.h > 300) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'y + h 超出屏幕高度 300' });
      }
    });
  });
export type DashboardLayoutT = z.infer<typeof DashboardLayout>;

// POST /api/v1/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
//   capability URL: contentId(cuid) 本身充当访问能力，不需要额外 token。
//   bodyLimit 64KB；rate-limit 30/min/contentId。
export const IngestPayload = z.object({
  heading: z.string().max(48).optional(),
  subtitle: z.string().max(48).optional(),
  /** 自由 key/value：number / string / boolean，最多 8 个 metric。 */
  metrics: z
    .record(z.string().max(32), z.union([z.number(), z.string().max(64), z.boolean()]))
    .refine((r) => Object.keys(r).length <= 8, '最多 8 个 metric')
    .optional(),
  /** sparkline 数据点序列，最多 60 个。 */
  series: z.array(z.number()).max(60).optional(),
  /** 受限设备版式 DSL。外部可自定义 dashboard 布局，但不支持 HTML/CSS/JS。 */
  layout: DashboardLayout.optional(),
  /** layout 绑定用的自由 JSON 数据根。 */
  data: z.record(z.string().max(64), z.unknown()).optional(),
  /** 客户端时间，仅展示，不参与校时。 */
  updated_at: z.string().datetime().optional(),
});
export type IngestPayloadT = z.infer<typeof IngestPayload>;

export const IngestResponse = z.object({
  content_id: z.string(),
  image_etag: z.string(),
  group_etag: z.string(),
  rendered_at: z.string().datetime(),
});
export type IngestResponseT = z.infer<typeof IngestResponse>;
