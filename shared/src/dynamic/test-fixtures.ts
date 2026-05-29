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
    {
      model: 'gpt-5.5',
      requests: 10075,
      input_tokens: 82000000,
      output_tokens: 5200000,
      cache_creation_tokens: 0,
      cache_read_tokens: 1008300000,
      total_tokens: 1090500000,
      cost: 1022.593,
      actual_cost: 1022.593,
      account_cost: 0,
    },
    {
      model: 'claude-sonnet-4-6',
      requests: 1500,
      input_tokens: 7600000,
      output_tokens: 640000,
      cache_creation_tokens: 0,
      cache_read_tokens: 91860000,
      total_tokens: 100100000,
      cost: 57.8415,
      actual_cost: 57.8415,
      account_cost: 0,
    },
    {
      model: 'gpt-5.4-mini',
      requests: 2,
      input_tokens: 11000,
      output_tokens: 7400,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 18400,
      cost: 0.0063,
      actual_cost: 0.0063,
      account_cost: 0,
    },
  ],
  updated_label: '05-26 16:30',
} as const;

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

export const DASHBOARD_SYSTEM_TEMPLATE_TEST_DATA = {
  ai_usage_stats: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  ai_quota_monitor: DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
} as const satisfies Record<DashboardSystemTemplateIdT, Record<string, unknown>>;

export const DASHBOARD_SYSTEM_TEMPLATE_FIXTURES = {
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
