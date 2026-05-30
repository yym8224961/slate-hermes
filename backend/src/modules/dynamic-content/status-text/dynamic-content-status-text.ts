import type { ContentKind, Prisma } from '@prisma/client';
import {
  DASHBOARD_SYSTEM_TEMPLATES,
  DashboardConfig,
  FONT_TEST_FONTS,
  HotListConfig,
  hotListSourceShortLabel,
  normalizeWeatherAlertProvince,
} from 'shared';
import { recordValue, valueText } from '../../../common/utils/value-utils';
import { cnMonthDay, datePartsInTz, timezoneFromConfig } from '../timezone';

export interface ContentStatusBarSource {
  kind: ContentKind;
  frameName: string | null;
  dynamicType: string | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  renderedAt?: Date | null;
}

export function deviceStatusBarText(row: ContentStatusBarSource): string {
  if (row.kind !== 'dynamic') return row.frameName ?? '';
  // 依赖 renderedAt 的动态类型在首次渲染前用 frameName 占位。
  // 不用 `new Date()` 兜底：会让 etag 计算路径在每次刷新时漂移，下游 manifest etag
  // 持续抖动到首次渲染落库，把 304 缓存优势打掉。
  switch (row.dynamicType) {
    case 'daily_calendar':
      if (!row.renderedAt) return row.frameName ?? '';
      return dailyCalendarStatusBarText(row.dynamicData, row.dynamicConfig, row.renderedAt);
    case 'month_calendar':
      if (!row.renderedAt) return row.frameName ?? '';
      return monthCalendarStatusBarText(row.dynamicConfig, row.renderedAt);
    case 'history_today':
      if (!row.renderedAt) return row.frameName ?? '';
      return historyTodayStatusBarText(row.dynamicData, row.dynamicConfig, row.renderedAt);
    case 'weather_alert':
      return weatherAlertStatusBarText(row.dynamicConfig);
    case 'earthquake_report':
      return '地震速报';
    case 'weather':
      return weatherStatusBarText(row.dynamicConfig);
    case 'dashboard':
      return row.frameName ?? dashboardStatusBarText(row.dynamicConfig);
    case 'font_test':
      return fontTestStatusBarText(row.dynamicConfig);
    case 'hot_list':
      return hotListStatusBarText(row.dynamicConfig);
    default:
      return row.frameName ?? '';
  }
}

export function defaultDynamicFrameName(
  dynamicType: string | null,
  config?: unknown
): string | null {
  switch (dynamicType) {
    case 'daily_calendar':
      return '日历';
    case 'month_calendar':
      return '月历';
    case 'history_today':
      return '历史上的今天';
    case 'weather_alert':
      return weatherAlertStatusBarText(config);
    case 'earthquake_report':
      return '地震速报';
    case 'weather':
      return weatherStatusBarText(config);
    case 'dashboard':
      return dashboardStatusBarText(config);
    case 'font_test':
      return fontTestStatusBarText(config);
    case 'hot_list':
      return hotListStatusBarText(config);
    default:
      return null;
  }
}

function dailyCalendarStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const parts = datePartsInTz(renderedAt, timezoneFromConfig(config));
  const month = valueText(recordValue(data, 'month')) ?? String(parts.month);
  const day = valueText(recordValue(data, 'day')) ?? String(parts.day);
  return `${Number(month)}月${Number(day)}日`;
}

function monthCalendarStatusBarText(
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const parts = datePartsInTz(renderedAt, timezoneFromConfig(config));
  return `${parts.year}年${parts.month}月`;
}

function historyTodayStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const label =
    valueText(recordValue(data, 'dateLabel')) ?? cnMonthDay(renderedAt, timezoneFromConfig(config));
  return `历史上的${label.replace(/\s+/g, '')}`;
}

export function weatherStatusBarText(config: unknown): string {
  const location = valueText(recordValue(config, 'location_label')) ?? '天气';
  return location === '天气' ? '天气' : `${location}天气`;
}

export function weatherAlertStatusBarText(config: unknown): string {
  const province = normalizeWeatherAlertProvince(valueText(recordValue(config, 'province')) ?? '');
  return `${province || '全国'}气象预警`;
}

export function dashboardStatusBarText(config: unknown): string {
  const parsed = DashboardConfig.safeParse(config);
  if (!parsed.success) return '外部数据';
  if (parsed.data.template.kind === 'system') {
    return DASHBOARD_SYSTEM_TEMPLATES[parsed.data.template.id]?.label ?? '外部数据';
  }
  return parsed.data.template.template.name?.trim() || '自定义模板';
}

export function fontTestStatusBarText(config: unknown): string {
  const id = valueText(recordValue(config, 'font_id'));
  return id ? (FONT_TEST_FONTS.find((font) => font.id === id)?.label ?? '字体测试') : '字体测试';
}

export function hotListStatusBarText(config: unknown): string {
  const parsed = HotListConfig.safeParse(config);
  if (!parsed.success) return '热榜';
  return `${hotListSourceShortLabel(parsed.data.source)}热榜`;
}
