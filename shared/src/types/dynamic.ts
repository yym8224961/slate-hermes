import { z } from 'zod';

// 内置动态内容类型清单。每种对应 backend/src/modules/widgets/definitions/*.json 一份模板。
export const DynamicType = z.enum(['date', 'weather', 'history_today', 'dashboard']);
export type DynamicTypeT = z.infer<typeof DynamicType>;

// IANA 时区。前端默认用浏览器 Intl.DateTimeFormat().resolvedOptions().timeZone。
const Tz = z.string().min(1).max(48);

// 各动态内容类型的 config schema。discriminated union 让前后端共用同一份校验。

export const DateConfig = z.object({
  type: z.literal('date'),
  tz: Tz,
  show_lunar: z.boolean().default(true),
  show_solar_term: z.boolean().default(true),
});
export type DateConfigT = z.infer<typeof DateConfig>;

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
  title: z.string().max(48).optional(),
  layout: z.enum(['metrics', 'sparkline']).default('metrics'),
});
export type DashboardConfigT = z.infer<typeof DashboardConfig>;

export const DynamicConfig = z.discriminatedUnion('type', [
  DateConfig,
  WeatherConfig,
  HistoryTodayConfig,
  DashboardConfig,
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

export const DashboardLayout = z.object({
  version: z.literal(1).default(1),
  title: z.string().max(48).optional(),
  blocks: z.array(DashboardLayoutBlock).min(1).max(24),
});
export type DashboardLayoutT = z.infer<typeof DashboardLayout>;

// POST /api/v1/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
//   capability URL: contentId(cuid) 本身充当访问能力，不需要额外 token。
//   bodyLimit 64KB；rate-limit 30/min/contentId。
export const IngestPayload = z.object({
  title: z.string().max(48).optional(),
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
