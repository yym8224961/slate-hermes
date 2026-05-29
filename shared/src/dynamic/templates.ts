import { z } from 'zod';

const DeviceRect = z.object({
  x: z.number().int().min(0).max(399),
  y: z.number().int().min(24).max(299),
  w: z.number().int().min(1).max(400),
  h: z.number().int().min(1).max(276),
});

const BindingText = z.string().min(1).max(160);
const TemplateColor = z.enum(['black', 'white']);
const DashboardTextFontSize = z.union([z.literal(12), z.literal(16)]);
const DashboardProgressBarHeight = z.number().int().min(4).max(24);

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
    label_font_size: DashboardTextFontSize.default(12),
    value_font_size: DashboardTextFontSize.default(12),
    bar_height: DashboardProgressBarHeight.default(9),
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
    {
      type: 'metric',
      x: 20,
      y: 34,
      w: 84,
      h: 48,
      label: '今日消费',
      value: '{today_cost_usd|usd2}',
    },
    {
      type: 'metric',
      x: 112,
      y: 34,
      w: 84,
      h: 48,
      label: '今日请求',
      value: '{today_request_count|int}',
    },
    {
      type: 'metric',
      x: 204,
      y: 34,
      w: 84,
      h: 48,
      label: '今日Token',
      value: '{today_token_count|tokens}',
    },
    {
      type: 'metric',
      x: 296,
      y: 34,
      w: 84,
      h: 48,
      label: '今日缓存率',
      value: '{today_cache_hit_rate_percent|percent}',
    },
    {
      type: 'metric',
      x: 20,
      y: 92,
      w: 84,
      h: 48,
      label: '累计消费',
      value: '{total_cost_usd|usd2}',
    },
    {
      type: 'metric',
      x: 112,
      y: 92,
      w: 84,
      h: 48,
      label: '累计请求',
      value: '{total_request_count|int}',
    },
    {
      type: 'metric',
      x: 204,
      y: 92,
      w: 84,
      h: 48,
      label: '累计Token',
      value: '{total_token_count|tokens}',
    },
    {
      type: 'metric',
      x: 296,
      y: 92,
      w: 84,
      h: 48,
      label: '总缓存率',
      value: '{total_cache_hit_rate_percent|percent}',
    },
    {
      type: 'metric',
      x: 20,
      y: 150,
      w: 84,
      h: 48,
      label: '平均响应',
      value: '{average_latency_ms|duration}',
    },
    {
      type: 'metric',
      x: 112,
      y: 150,
      w: 84,
      h: 48,
      label: '今日均价',
      value: '{today_cost_per_million_tokens_usd|usd_per_million}',
    },
    {
      type: 'metric',
      x: 204,
      y: 150,
      w: 84,
      h: 48,
      label: '累计均价',
      value: '{total_cost_per_million_tokens_usd|usd_per_million}',
    },
    {
      type: 'metric',
      x: 296,
      y: 150,
      w: 84,
      h: 48,
      label: '更新时间',
      value: '{last_updated_time_label}',
    },
    { type: 'line', x1: 20, y1: 218, x2: 380, y2: 218, style: 'dashed' },
    {
      type: 'text',
      x: 20,
      y: 237,
      w: 120,
      h: 12,
      value: '按平台拆分',
      font_size: 12,
    },
    {
      type: 'text',
      x: 170,
      y: 237,
      w: 58,
      h: 12,
      value: '今日',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 240,
      y: 237,
      w: 58,
      h: 12,
      value: '请求',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 310,
      y: 237,
      w: 70,
      h: 12,
      value: 'Token',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 20,
      y: 255,
      w: 130,
      h: 12,
      value: '{platform_breakdown.0.platform_name}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 170,
      y: 255,
      w: 58,
      h: 12,
      value: '{platform_breakdown.0.today_cost_usd|usd2}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 240,
      y: 255,
      w: 58,
      h: 12,
      value: '{platform_breakdown.0.today_request_count|int}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 310,
      y: 255,
      w: 70,
      h: 12,
      value: '{platform_breakdown.0.today_token_count|tokens}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 20,
      y: 275,
      w: 130,
      h: 12,
      value: '{platform_breakdown.1.platform_name}',
      font_size: 12,
    },
    {
      type: 'text',
      x: 170,
      y: 275,
      w: 58,
      h: 12,
      value: '{platform_breakdown.1.today_cost_usd|usd2}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 240,
      y: 275,
      w: 58,
      h: 12,
      value: '{platform_breakdown.1.today_request_count|int}',
      font_size: 12,
      align: 'right',
    },
    {
      type: 'text',
      x: 310,
      y: 275,
      w: 70,
      h: 12,
      value: '{platform_breakdown.1.today_token_count|tokens}',
      font_size: 12,
      align: 'right',
    },
  ],
});

export const DASHBOARD_CUSTOM_STARTER_TEMPLATE = DashboardTemplate.parse({
  version: 1,
  name: '自定义模板',
  blocks: [
    {
      type: 'metric',
      x: 20,
      y: 34,
      w: 170,
      h: 62,
      label: '{primary_label}',
      value: '{primary_value}',
      sparkline: '{primary_trend}',
    },
    {
      type: 'metric',
      x: 210,
      y: 34,
      w: 170,
      h: 62,
      label: '{secondary_label}',
      value: '{secondary_value}',
    },
    {
      type: 'metric',
      x: 20,
      y: 106,
      w: 170,
      h: 62,
      label: '{third_label}',
      value: '{third_value}',
    },
    {
      type: 'metric',
      x: 210,
      y: 106,
      w: 170,
      h: 62,
      label: '{fourth_label}',
      value: '{fourth_value}',
    },
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
    {
      type: 'text',
      x: 210,
      y: 270,
      w: 170,
      h: 14,
      value: '{footer_right}',
      font_size: 12,
      align: 'right',
    },
  ],
});

export const DASHBOARD_AI_QUOTA_MONITOR_TEMPLATE = DashboardTemplate.parse({
  version: 1,
  name: 'AI 限额监控',
  blocks: [
    { type: 'metric', x: 20, y: 44, w: 110, h: 52, label: '服务', value: '{service_label}' },
    { type: 'metric', x: 145, y: 44, w: 110, h: 52, label: '套餐', value: '{plan_label}' },
    { type: 'metric', x: 270, y: 44, w: 110, h: 52, label: '状态', value: '{status_label}' },
    {
      type: 'progress',
      x: 20,
      y: 120,
      w: 360,
      h: 34,
      label: '{primary_window_label}',
      percentage: '{primary_used_percent}',
      value_text: '{primary_used_percent|int}%',
      label_font_size: 16,
      value_font_size: 16,
      bar_height: 14,
    },
    {
      type: 'progress',
      x: 20,
      y: 162,
      w: 360,
      h: 34,
      label: '{secondary_window_label}',
      percentage: '{secondary_used_percent}',
      value_text: '{secondary_used_percent|int}%',
      label_font_size: 16,
      value_font_size: 16,
      bar_height: 14,
    },
    { type: 'line', x1: 20, y1: 210, x2: 380, y2: 210, style: 'dashed' },
    {
      type: 'metric',
      x: 20,
      y: 228,
      w: 110,
      h: 52,
      label: '5小时重置',
      value: '{primary_reset_at_label}',
    },
    {
      type: 'metric',
      x: 145,
      y: 228,
      w: 110,
      h: 52,
      label: '周重置',
      value: '{secondary_reset_at_label}',
    },
    { type: 'metric', x: 270, y: 228, w: 110, h: 52, label: '更新', value: '{updated_label}' },
  ],
});

export const DASHBOARD_SYSTEM_TEMPLATES = {
  ai_usage_stats: {
    id: 'ai_usage_stats',
    label: 'AI 使用统计',
    description: '展示今日/累计消费、请求、Token、缓存率、均价、响应时间和平台拆分。',
    template: DASHBOARD_AI_USAGE_STATS_TEMPLATE,
  },
  ai_quota_monitor: {
    id: 'ai_quota_monitor',
    label: 'AI 限额监控',
    description:
      '展示 Claude Code 或 Codex/OpenAI 单服务限额快照；只放使用率、状态、绝对重置时间和更新时间。',
    template: DASHBOARD_AI_QUOTA_MONITOR_TEMPLATE,
  },
} as const satisfies Record<
  DashboardSystemTemplateIdT,
  {
    id: DashboardSystemTemplateIdT;
    label: string;
    description: string;
    template: DashboardTemplateT;
  }
>;
