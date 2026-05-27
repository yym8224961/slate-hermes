import { z } from 'zod';
import { HotListConfig } from './hot-list-sources.js';

export * from './hot-list-sources.js';

// 内置动态内容类型清单。每种对应一个服务端 compiler + 设备端基础 block 组合。
export const DynamicType = z.enum([
  'daily_calendar',
  'month_calendar',
  'weather',
  'history_today',
  'weather_alert',
  'earthquake_report',
  'dashboard',
  'font_test',
  'hot_list',
]);
export type DynamicTypeT = z.infer<typeof DynamicType>;

// IANA 时区。前端默认用浏览器 Intl.DateTimeFormat().resolvedOptions().timeZone。
const Tz = z.string().min(1).max(48);

export const TTS_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] as const;
export const DEFAULT_TTS_VOICE = '冰糖';
export const TtsVoice = z.enum(TTS_VOICES);
export type TtsVoiceT = z.infer<typeof TtsVoice>;

export function isTtsVoice(value: string): value is TtsVoiceT {
  return (TTS_VOICES as readonly string[]).includes(value);
}

const DynamicAudioOptions = z.object({
  audio_enabled: z.boolean().default(false),
  audio_voice: TtsVoice.default(DEFAULT_TTS_VOICE),
});

const DynamicRefreshOptions = z.object({
  refresh_interval_sec: z.coerce.number().int().min(300).max(86400).optional(),
});

// 各动态内容类型的 config schema。discriminated union 让前后端共用同一份校验。

export const DailyCalendarConfig = z
  .object({
    type: z.literal('daily_calendar'),
    tz: Tz,
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type DailyCalendarConfigT = z.infer<typeof DailyCalendarConfig>;

export const MonthCalendarConfig = z
  .object({
    type: z.literal('month_calendar'),
    tz: Tz,
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type MonthCalendarConfigT = z.infer<typeof MonthCalendarConfig>;

export const WeatherConfig = z
  .object({
    type: z.literal('weather'),
    tz: Tz,
    provider: z.enum(['qweather']).default('qweather'),
    location_id: z.string().min(1).max(32),
    location_label: z.string().min(1).max(32),
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type WeatherConfigT = z.infer<typeof WeatherConfig>;

export const HistoryTodayConfig = z
  .object({
    type: z.literal('history_today'),
    tz: Tz,
    source: z.enum(['wikipedia', 'baidu_baike']).default('wikipedia'),
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type HistoryTodayConfigT = z.infer<typeof HistoryTodayConfig>;

export const WEATHER_ALERT_PROVINCES = [
  '北京市',
  '上海市',
  '天津市',
  '重庆市',
  '黑龙江省',
  '吉林省',
  '辽宁省',
  '内蒙古自治区',
  '河北省',
  '山西省',
  '陕西省',
  '山东省',
  '新疆维吾尔自治区',
  '西藏自治区',
  '青海省',
  '甘肃省',
  '宁夏回族自治区',
  '河南省',
  '江苏省',
  '湖北省',
  '浙江省',
  '安徽省',
  '福建省',
  '江西省',
  '湖南省',
  '贵州省',
  '四川省',
  '广东省',
  '云南省',
  '广西壮族自治区',
  '海南省',
] as const;
export type WeatherAlertProvinceT = (typeof WEATHER_ALERT_PROVINCES)[number];

const weatherAlertProvinceAliases = new Map<string, WeatherAlertProvinceT>(
  WEATHER_ALERT_PROVINCES.flatMap((province) => {
    const aliases = new Set<string>([
      province,
      province.replace(/省$|市$/, ''),
      province.replace(/(?:壮族|回族|维吾尔)?自治区$/, ''),
      province.replace(/(?:壮族|回族|维吾尔)自治区$/, '自治区'),
    ]);
    aliases.delete('');
    return [...aliases].map((alias) => [alias, province] as const);
  })
);

export function isWeatherAlertProvince(value: string): value is WeatherAlertProvinceT {
  return (WEATHER_ALERT_PROVINCES as readonly string[]).includes(value);
}

export function normalizeWeatherAlertProvince(value: string): string {
  const text = value.trim();
  if (!text || text === '全国' || text === '全部' || text === '中国') return '';
  return weatherAlertProvinceAliases.get(text) ?? '';
}

export const WeatherAlertConfig = z.object({
  type: z.literal('weather_alert'),
  province: z.string().max(16).default(''),
  refresh_interval_sec: z.coerce.number().int().min(300).max(86400).default(600),
});
export type WeatherAlertConfigT = z.infer<typeof WeatherAlertConfig>;

export const EarthquakeReportConfig = z.object({
  type: z.literal('earthquake_report'),
  refresh_interval_sec: z.coerce.number().int().min(300).max(86400).default(600),
});
export type EarthquakeReportConfigT = z.infer<typeof EarthquakeReportConfig>;

const DeviceRect = z.object({
  x: z.number().int().min(0).max(399),
  y: z.number().int().min(24).max(299),
  w: z.number().int().min(1).max(400),
  h: z.number().int().min(1).max(276),
});

const BindingText = z.string().min(1).max(160);
const TemplateColor = z.enum(['black', 'white']);
const DashboardTextFontSize = z.union([z.literal(12), z.literal(16)]);

export const DashboardTemplateBlock = z.discriminatedUnion('type', [
  DeviceRect.extend({
    type: z.literal('text'),
    value: BindingText,
    font_size: DashboardTextFontSize.default(16),
    align: z.enum(['left', 'center', 'right']).default('left'),
    color: TemplateColor.default('black'),
    max_lines: z.number().int().min(1).max(4).default(1),
  }),
  DeviceRect.extend({
    type: z.literal('metric'),
    label: BindingText,
    value: BindingText,
    sparkline: z.union([BindingText, z.array(z.number()).min(2).max(60)]).optional(),
  }),
  DeviceRect.extend({
    type: z.literal('progress'),
    label: BindingText,
    value: BindingText.optional(),
    max: BindingText.optional(),
    value_text: BindingText.optional(),
    percentage: z.union([BindingText, z.number().min(0).max(100)]).optional(),
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
export type DashboardTemplateBlockT = z.infer<typeof DashboardTemplateBlock>;

export const DashboardTemplate = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().max(48).optional(),
    blocks: z.array(DashboardTemplateBlock).min(1).max(32),
  })
  .superRefine((template, ctx) => {
    template.blocks.forEach((block, i) => {
      if (!('x' in block)) return;
      if (block.x + block.w > 400) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'x + w 超出屏幕宽度 400' });
      }
      if (block.y + block.h > 300) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i], message: 'y + h 超出屏幕高度 300' });
      }
    });
  });
export type DashboardTemplateT = z.infer<typeof DashboardTemplate>;

export const DashboardSystemTemplateIdValues = ['ai_usage_stats', 'ai_quota_monitor'] as const;
export const DashboardSystemTemplateId = z.enum(DashboardSystemTemplateIdValues);
export type DashboardSystemTemplateIdT = z.infer<typeof DashboardSystemTemplateId>;

export const DASHBOARD_AI_USAGE_STATS_TEMPLATE = DashboardTemplate.parse({
  version: 1,
  name: 'AI 使用统计',
  blocks: [
    { type: 'metric', x: 20, y: 34, w: 110, h: 52, label: '余额', value: '{balance|usd2}' },
    {
      type: 'metric',
      x: 145,
      y: 34,
      w: 110,
      h: 52,
      label: '累计Token',
      value: '{total_tokens|tokens}',
    },
    {
      type: 'metric',
      x: 270,
      y: 34,
      w: 110,
      h: 52,
      label: 'API Key',
      value: '{active_api_keys|int}/{total_api_keys|int}',
    },
    {
      type: 'metric',
      x: 20,
      y: 94,
      w: 110,
      h: 52,
      label: '今日请求',
      value: '{today_requests|int}',
    },
    {
      type: 'metric',
      x: 145,
      y: 94,
      w: 110,
      h: 52,
      label: '今日消费',
      value: '{today_actual_cost|usd2}',
    },
    {
      type: 'metric',
      x: 270,
      y: 94,
      w: 110,
      h: 52,
      label: '今日Token',
      value: '{today_tokens|tokens}',
    },
    { type: 'metric', x: 20, y: 154, w: 110, h: 46, label: 'RPM', value: '{rpm|int}' },
    {
      type: 'metric',
      x: 145,
      y: 154,
      w: 110,
      h: 46,
      label: '平均响应',
      value: '{average_duration_ms|duration}',
    },
    {
      type: 'metric',
      x: 270,
      y: 154,
      w: 110,
      h: 46,
      label: '更新',
      value: '{updated_label}',
    },
    { type: 'line', x1: 20, y1: 214, x2: 380, y2: 214, style: 'dashed' },
    {
      type: 'text',
      x: 20,
      y: 224,
      w: 48,
      h: 12,
      value: '平台',
      font_size: 12,
    },
    {
      type: 'text',
      x: 90,
      y: 224,
      w: 46,
      h: 12,
      value: '今日',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 142,
      y: 224,
      w: 48,
      h: 12,
      value: '累计',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 20,
      y: 242,
      w: 68,
      h: 12,
      value: '{by_platform.0.platform}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 90,
      y: 242,
      w: 46,
      h: 12,
      value: '{by_platform.0.today_actual_cost|usd2}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 142,
      y: 242,
      w: 48,
      h: 12,
      value: '{by_platform.0.total_tokens|tokens}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 20,
      y: 260,
      w: 68,
      h: 12,
      value: '{by_platform.1.platform}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 90,
      y: 260,
      w: 46,
      h: 12,
      value: '{by_platform.1.today_actual_cost|usd2}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 142,
      y: 260,
      w: 48,
      h: 12,
      value: '{by_platform.1.total_tokens|tokens}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 216,
      y: 224,
      w: 48,
      h: 12,
      value: '模型',
      font_size: 12,
    },
    {
      type: 'text',
      x: 328,
      y: 224,
      w: 52,
      h: 12,
      value: 'Token',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 216,
      y: 242,
      w: 106,
      h: 12,
      value: '{models.0.model}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 328,
      y: 242,
      w: 52,
      h: 12,
      value: '{models.0.total_tokens|tokens}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 216,
      y: 260,
      w: 106,
      h: 12,
      value: '{models.1.model}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 328,
      y: 260,
      w: 52,
      h: 12,
      value: '{models.1.total_tokens|tokens}',
      font_size: 12,
      align: 'right',
    },
  ],
});

export const DASHBOARD_CUSTOM_STARTER_TEMPLATE = DashboardTemplate.parse({
  version: 1,
  name: '自定义模板',
  blocks: [
    { type: 'metric', x: 20, y: 34, w: 170, h: 62, label: '{primary_label}', value: '{primary_value}', sparkline: '{primary_trend}' },
    { type: 'metric', x: 210, y: 34, w: 170, h: 62, label: '{secondary_label}', value: '{secondary_value}' },
    { type: 'metric', x: 20, y: 106, w: 170, h: 62, label: '{third_label}', value: '{third_value}' },
    { type: 'metric', x: 210, y: 106, w: 170, h: 62, label: '{fourth_label}', value: '{fourth_value}' },
    { type: 'line', x1: 20, y1: 184, x2: 380, y2: 184, style: 'dashed' },
    {
      type: 'progress',
      x: 20,
      y: 198,
      w: 360,
      h: 24,
      label: '{primary_progress_label}',
      percentage: '{primary_progress_percent}',
      value_text: '{primary_progress_text}',
    },
    {
      type: 'progress',
      x: 20,
      y: 228,
      w: 360,
      h: 24,
      label: '{secondary_progress_label}',
      percentage: '{secondary_progress_percent}',
      value_text: '{secondary_progress_text}',
    },
    { type: 'text', x: 20, y: 270, w: 170, h: 14, value: '{footer_left}', font_size: 12 },
    { type: 'text', x: 210, y: 270, w: 170, h: 14, value: '{footer_right}', font_size: 12, align: 'right' },
  ],
});

export const DASHBOARD_CUSTOM_STARTER_TEST_DATA = {
  primary_label: '收入',
  primary_value: '128k',
  primary_trend: [3, 8, 5, 13, 21, 18, 26],
  secondary_label: '请求',
  secondary_value: '42.8k',
  third_label: '转化率',
  third_value: '12.6%',
  fourth_label: '延迟',
  fourth_value: '183ms',
  primary_progress_label: '目标',
  primary_progress_percent: 72,
  primary_progress_text: '72%',
  secondary_progress_label: '健康',
  secondary_progress_percent: 91,
  secondary_progress_text: '91%',
  footer_left: '05-27 16:30',
  footer_right: '业务看板',
} as const;

export const DASHBOARD_AI_USAGE_STATS_TEST_DATA = {
  balance: 8139.8,
  total_api_keys: 8,
  active_api_keys: 8,
  total_requests: 20305,
  total_input_tokens: 124300000,
  total_output_tokens: 11300000,
  total_cache_creation_tokens: 0,
  total_cache_read_tokens: 1966700000,
  total_tokens: 2102300000,
  total_cost: 1860.1969,
  total_actual_cost: 1860.1969,
  today_requests: 1602,
  today_input_tokens: 11700000,
  today_output_tokens: 798100,
  today_cache_creation_tokens: 0,
  today_cache_read_tokens: 160001900,
  today_tokens: 172500000,
  today_cost: 155.7732,
  today_actual_cost: 155.7732,
  average_duration_ms: 17270,
  rpm: 2,
  by_platform: [
    {
      platform: 'OpenAI',
      total_requests: 17012,
      total_tokens: 1880900000,
      total_actual_cost: 1743.2521,
      today_requests: 1602,
      today_tokens: 172500000,
      today_actual_cost: 146.2964,
    },
    {
      platform: 'Claude',
      total_requests: 3282,
      total_tokens: 221400000,
      total_actual_cost: 116.9448,
      today_requests: 0,
      today_tokens: 0,
      today_actual_cost: 9.4768,
    },
  ],
  models: [
    { model: 'gpt-5.5', requests: 10075, input_tokens: 82000000, output_tokens: 5200000, cache_creation_tokens: 0, cache_read_tokens: 1008300000, total_tokens: 1090500000, cost: 1022.593, actual_cost: 1022.593, account_cost: 0 },
    { model: 'claude-sonnet-4-6', requests: 1500, input_tokens: 7600000, output_tokens: 640000, cache_creation_tokens: 0, cache_read_tokens: 91860000, total_tokens: 100100000, cost: 57.8415, actual_cost: 57.8415, account_cost: 0 },
    { model: 'gpt-5.4-mini', requests: 2, input_tokens: 11000, output_tokens: 7400, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 18400, cost: 0.0063, actual_cost: 0.0063, account_cost: 0 },
  ],
  updated_label: '05-26 16:30',
} as const;

export const DASHBOARD_AI_QUOTA_MONITOR_TEMPLATE = DashboardTemplate.parse({
  version: 1,
  name: 'AI 限额监控',
  blocks: [
    { type: 'metric', x: 20, y: 34, w: 110, h: 52, label: '服务', value: '{service_label}' },
    { type: 'metric', x: 145, y: 34, w: 110, h: 52, label: '套餐', value: '{plan_label}' },
    { type: 'metric', x: 270, y: 34, w: 110, h: 52, label: '状态', value: '{status_label}' },
    {
      type: 'progress',
      x: 20,
      y: 110,
      w: 360,
      h: 26,
      label: '{primary_window_label}',
      percentage: '{primary_used_percent}',
      value_text: '{primary_used_percent|int}%',
    },
    {
      type: 'progress',
      x: 20,
      y: 150,
      w: 360,
      h: 26,
      label: '{secondary_window_label}',
      percentage: '{secondary_used_percent}',
      value_text: '{secondary_used_percent|int}%',
    },
    { type: 'line', x1: 20, y1: 200, x2: 380, y2: 200, style: 'dashed' },
    { type: 'metric', x: 20, y: 218, w: 110, h: 52, label: '5h重置', value: '{primary_reset_at_label}' },
    { type: 'metric', x: 145, y: 218, w: 110, h: 52, label: '周重置', value: '{secondary_reset_at_label}' },
    { type: 'metric', x: 270, y: 218, w: 110, h: 52, label: '更新', value: '{updated_label}' },
  ],
});

export const DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA = {
  service_label: 'Claude Code',
  plan_label: 'Pro',
  status_label: '正常',
  primary_window_label: '5h窗口',
  primary_used_percent: 68,
  primary_reset_at_label: '05-27 20:00',
  secondary_window_label: '周限额',
  secondary_used_percent: 41,
  secondary_reset_at_label: '06-03 08:00',
  updated_label: '05-27 16:30',
} as const;

export const DASHBOARD_SYSTEM_TEMPLATES = {
  ai_usage_stats: {
    id: 'ai_usage_stats',
    label: 'AI 使用统计',
    description: '展示余额、API Key、请求、消费、Token、响应时间、更新时间、平台和模型分布。',
    template: DASHBOARD_AI_USAGE_STATS_TEMPLATE,
    test_data: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  },
  ai_quota_monitor: {
    id: 'ai_quota_monitor',
    label: 'AI 限额监控',
    description: '展示 Claude Code 或 Codex/OpenAI 单服务限额快照；只放使用率、状态、绝对重置时间和更新时间。',
    template: DASHBOARD_AI_QUOTA_MONITOR_TEMPLATE,
    test_data: DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
  },
} as const satisfies Record<
  DashboardSystemTemplateIdT,
  {
    id: DashboardSystemTemplateIdT;
    label: string;
    description: string;
    template: DashboardTemplateT;
    test_data: Record<string, unknown>;
  }
>;

export const DashboardTemplateRef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('system'),
    id: DashboardSystemTemplateId.default('ai_usage_stats'),
  }),
  z.object({
    kind: z.literal('custom'),
    template: DashboardTemplate,
  }),
]);
export type DashboardTemplateRefT = z.infer<typeof DashboardTemplateRef>;

export const DashboardConfig = z.object({
  type: z.literal('dashboard'),
  template: DashboardTemplateRef.default({
    kind: 'custom',
    template: DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  }),
  test_data: z.record(z.string().max(64), z.unknown()).default(DASHBOARD_CUSTOM_STARTER_TEST_DATA),
});
export type DashboardConfigT = z.infer<typeof DashboardConfig>;

export const ICON_FONT_TEST_SAMPLE =
  '\uf240 \uf241 \uf242 \uf243 \uf244 \uf1eb \uf028 \uf001 \uf00c \uf00d \uf011 \uf013 \uf015 \uf03e \uf044 \uf04b \uf04c \uf04d \uf060 \uf061 \uf062 \uf063 \uf071 \uf0f3 \uf3c5 \uf0ac \uf075 \uf007 \uf019 \uf023 \uf084 \uf05a \uf059 \uf058 \uf057 \uf017 \uf110';

export const FontTestFontIdValues = [
  'fusion_pixel_8',
  'fusion_pixel_10',
  'fusion_pixel_12',
  'ark_pixel_10',
  'ark_pixel_12',
  'ark_pixel_16',
  'zlabs_pixel_12',
  'zlabs_roundpix_12',
  'zlabs_roundpix_16',
  'chill_bitmap_16',
  'xiaoya_pixel_12',
  'cubic_11',
  'unifont_16',
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
}

export const FONT_TEST_FONTS = [
  {
    id: 'fusion_pixel_8',
    label: 'Fusion Pixel 8',
    file: 'fusion-pixel-8.json',
    sizePx: 8,
    kind: 'cjk',
    hint: '8px full cmap',
    note: '按源字体 cmap 全量生成的小号泛中日韩像素黑体。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
  },
  {
    id: 'fusion_pixel_10',
    label: 'Fusion Pixel 10',
    file: 'fusion-pixel-10.json',
    sizePx: 10,
    kind: 'cjk',
    hint: '10px full cmap',
    note: '按源字体 cmap 全量生成，适合墨水屏小正文。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
  },
  {
    id: 'fusion_pixel_12',
    label: 'Fusion Pixel 12',
    file: 'fusion-pixel-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px full cmap',
    note: '按源字体 cmap 全量生成，中文正文覆盖较完整。',
    source: 'TakWolf/fusion-pixel-font',
    license: 'MIT',
  },
  {
    id: 'ark_pixel_10',
    label: 'Ark Pixel 10',
    file: 'ark-pixel-10.json',
    sizePx: 10,
    kind: 'cjk',
    hint: '10px full cmap',
    note: '按 Ark 10px 源字体 cmap 全量生成；源字体中文覆盖较小。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
  },
  {
    id: 'ark_pixel_12',
    label: 'Ark Pixel 12',
    file: 'ark-pixel-12.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px full cmap',
    note: '按 Ark 12px 源字体 cmap 全量生成，中号中文覆盖较好。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
  },
  {
    id: 'ark_pixel_16',
    label: 'Ark Pixel 16',
    file: 'ark-pixel-16.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px full cmap',
    note: '按 Ark 16px 源字体 cmap 全量生成；源字体中文覆盖有限。',
    source: 'TakWolf/ark-pixel-font',
    license: 'MIT',
  },
  {
    id: 'zlabs_pixel_12',
    label: 'Z Labs Pixel 12',
    file: 'zlabs-pixel-12-demo.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px demo subset',
    note: '中文像素黑体候选；测试页样张子集，适合和 Fusion/Ark 12px 对比。',
    source: 'Astro-2539/ZLabs-Pixel-12px',
    license: 'OFL-1.1',
  },
  {
    id: 'zlabs_roundpix_12',
    label: 'Z Labs RoundPix 12',
    file: 'zlabs-roundpix-12-demo.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px demo subset',
    note: '圆角像素中文候选；测试页样张子集，观察墨水屏边缘是否发糊。',
    source: 'Astro-2539/ZLabs-RoundPix-12px',
    license: 'OFL-1.1',
  },
  {
    id: 'zlabs_roundpix_16',
    label: 'Z Labs RoundPix 16',
    file: 'zlabs-roundpix-16-demo.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px demo subset',
    note: '圆角像素中文 16px 候选；测试页样张子集。',
    source: 'Astro-2539/ZLabs-RoundPix-16px',
    license: 'OFL-1.1',
  },
  {
    id: 'chill_bitmap_16',
    label: 'ChillBitmap 16',
    file: 'chill-bitmap-16-demo.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px demo subset',
    note: '寒蝉点阵体 16px 中文；测试页样张子集。',
    source: 'Warren2060/ChillBitmap',
    license: 'OFL-1.1',
  },
  {
    id: 'xiaoya_pixel_12',
    label: 'Xiaoya Pixel 12',
    file: 'xiaoya-pixel-12-demo.json',
    sizePx: 12,
    kind: 'cjk',
    hint: '12px demo subset',
    note: '小雅像素 Classic 候选；测试页样张子集，当前样张缺 1 个字。',
    source: 'DWNfonts/XiaoyaPixel-Classic',
    license: 'OFL-1.1',
  },
  {
    id: 'cubic_11',
    label: 'Cubic 11',
    file: 'cubic-11-demo.json',
    sizePx: 11,
    kind: 'cjk',
    hint: '11px demo subset',
    note: '俐方體 11 號；偏繁体/TW 风格，测试页样张子集。',
    source: 'ACh-K/Cubic-11',
    license: 'OFL-1.1',
  },
  {
    id: 'unifont_16',
    label: 'GNU Unifont 16',
    file: 'unifont-16.json',
    sizePx: 16,
    kind: 'cjk',
    hint: '16px full cmap',
    note: '按源字体 cmap 全量生成的宽覆盖 fallback，风格粗糙但缺字少。',
    source: 'multitheftauto/unifont',
    license: 'GNU Unifont',
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
  },
  {
    id: 'font_awesome_14',
    label: 'Font Awesome 14',
    file: 'font-awesome-14.json',
    sizePx: 14,
    kind: 'icon',
    hint: '14px full icons',
    note: '按 Font Awesome 5 源字体 cmap 全量生成的小号图标测试。',
    source: 'FortAwesome/Font-Awesome',
    license: 'Font Awesome Free',
  },
  {
    id: 'font_awesome_30',
    label: 'Font Awesome 30',
    file: 'font-awesome-30.json',
    sizePx: 30,
    kind: 'icon',
    hint: '30px full icons',
    note: '按 Font Awesome 5 源字体 cmap 全量生成的大号图标测试。',
    source: 'FortAwesome/Font-Awesome',
    license: 'Font Awesome Free',
  },
] as const satisfies readonly FontTestFontCatalogEntry[];

export const FontTestConfig = z.object({
  type: z.literal('font_test'),
  font_id: FontTestFontId.default('fusion_pixel_12'),
  invert: z.boolean().default(false),
});
export type FontTestConfigT = z.infer<typeof FontTestConfig>;

export const DynamicConfig = z.discriminatedUnion('type', [
  DailyCalendarConfig,
  MonthCalendarConfig,
  WeatherConfig,
  HistoryTodayConfig,
  WeatherAlertConfig,
  EarthquakeReportConfig,
  DashboardConfig,
  FontTestConfig,
  HotListConfig,
]);
export type DynamicConfigT = z.infer<typeof DynamicConfig>;

export function isAudioDynamicConfig(
  config: DynamicConfigT
): config is Extract<
  DynamicConfigT,
  { type: 'daily_calendar' | 'month_calendar' | 'weather' | 'history_today' }
> {
  return (
    config.type === 'daily_calendar' ||
    config.type === 'month_calendar' ||
    config.type === 'weather' ||
    config.type === 'history_today'
  );
}

const DashboardDataPayload = z.record(z.string().max(64), z.unknown());

// POST /api/v1/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
//   capability URL: contentId(cuid，~110 bit 熵) 本身充当访问能力，不需要额外 token。
//   防滥用靠 bodyLimit 64KB + rate-limit 30/min/contentId。
export const IngestPayload = z
  .object({
    version: z.literal(1),
    data: DashboardDataPayload,
  })
  .strict();
export type IngestPayloadT = z.infer<typeof IngestPayload>;

export const IngestResponse = z.object({
  id: z.string(),
  image_etag: z.string(),
  manifest_etag: z.string(),
  rendered_at: z.string().datetime(),
});
export type IngestResponseT = z.infer<typeof IngestResponse>;
