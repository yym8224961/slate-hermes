import {
  DASHBOARD_AI_QUOTA_MONITOR_TEMPLATE,
  DASHBOARD_AI_USAGE_STATS_TEMPLATE,
  type DashboardSystemTemplateIdT,
  type DashboardTemplateT,
} from './templates.js';

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
  today_cost_usd: 155.7732,
  today_request_count: 1602,
  today_token_count: 172500000,
  today_cache_hit_rate_percent: 93.2,
  total_cost_usd: 1860.1969,
  total_request_count: 20305,
  total_token_count: 2102300000,
  total_cache_hit_rate_percent: 94.0,
  average_latency_ms: 17270,
  today_cost_per_million_tokens_usd: 0.9,
  total_cost_per_million_tokens_usd: 0.88,
  last_updated_time_label: '16:30',
  last_updated_label: '05-26 16:30',
  platform_breakdown: [
    {
      platform_name: 'OpenAI',
      today_cost_usd: 146.2964,
      today_request_count: 1602,
      today_token_count: 172500000,
    },
    {
      platform_name: 'Claude',
      today_cost_usd: 9.4768,
      today_request_count: 0,
      today_token_count: 0,
    },
  ],
} as const;

export const DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA = {
  service_label: 'Claude Code',
  plan_label: 'Pro',
  status_label: '正常',
  primary_window_label: '5小时限额',
  primary_used_percent: 68,
  primary_reset_at_label: '05-27 20:00',
  secondary_window_label: '周限额',
  secondary_used_percent: 41,
  secondary_reset_at_label: '06-03 08:00',
  updated_label: '05-27 16:30',
} as const;

export const DASHBOARD_SYSTEM_TEMPLATE_TEST_DATA = {
  ai_usage_stats: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  ai_quota_monitor: DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
} as const satisfies Record<DashboardSystemTemplateIdT, Record<string, unknown>>;

export const DASHBOARD_SYSTEM_TEMPLATE_FIXTURES = {
  ai_usage_stats: {
    id: 'ai_usage_stats',
    label: 'AI 使用统计',
    description: '展示今日/累计消费、请求、Token、缓存率、均价、响应时间和平台拆分。',
    template: DASHBOARD_AI_USAGE_STATS_TEMPLATE,
    test_data: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  },
  ai_quota_monitor: {
    id: 'ai_quota_monitor',
    label: 'AI 限额监控',
    description:
      '展示 Claude Code 或 Codex/OpenAI 单服务限额快照；只放使用率、状态、绝对重置时间和更新时间。',
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
