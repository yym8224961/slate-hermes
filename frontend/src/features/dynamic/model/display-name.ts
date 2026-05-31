import {
  DASHBOARD_SYSTEM_TEMPLATES,
  FONT_TEST_FONTS,
  hotListSourceShortLabel,
  normalizeWeatherAlertProvince,
  type DashboardConfigT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import { zonedDateParts } from '@/features/dynamic/lib/date';

export function defaultDynamicFrameName(type: DynamicTypeT, config: DynamicConfigT): string {
  switch (type) {
    case 'daily_calendar':
      return '日历';
    case 'month_calendar':
      return '月历';
    case 'weather':
      return config.type === 'weather' && config.location_label
        ? `${config.location_label}天气`
        : '天气';
    case 'history_today':
      return '历史上的今天';
    case 'weather_alert':
      return dynamicStatusTitle(config) ?? '气象预警';
    case 'earthquake_report':
      return '地震速报';
    case 'dashboard':
      return config.type === 'dashboard' ? dashboardStatusTitle(config) : '外部数据';
    case 'font_test':
      return dynamicStatusTitle(config) ?? '字体测试';
    case 'hot_list':
      return dynamicStatusTitle(config) ?? '热榜';
  }
}

export function effectiveDynamicFrameName(
  type: DynamicTypeT,
  config: DynamicConfigT,
  frameName: string
): string {
  if (type === 'dashboard') return frameName.trim() || defaultDynamicFrameName(type, config);
  return defaultDynamicFrameName(type, config);
}

export function effectiveDynamicStatusBarText(
  type: DynamicTypeT | null,
  config: DynamicConfigT | null,
  frameName: string
): string | null {
  if (type === 'dashboard') {
    return (
      frameName.trim() || (config?.type === 'dashboard' ? dashboardStatusTitle(config) : '外部数据')
    );
  }
  return dynamicStatusTitle(config);
}

export function frameNameForSyncedDynamicConfigChange(
  previous: DynamicConfigT,
  next: DynamicConfigT
): string | null {
  if (
    next.type === 'weather' &&
    previous.type === 'weather' &&
    next.location_label !== previous.location_label
  ) {
    return defaultDynamicFrameName(next.type, next);
  }
  if (
    next.type === 'weather_alert' &&
    previous.type === 'weather_alert' &&
    next.province !== previous.province
  ) {
    return defaultDynamicFrameName(next.type, next);
  }
  return null;
}

export function dynamicStatusTitle(config: DynamicConfigT | null | undefined): string | null {
  if (!config) return null;

  switch (config.type) {
    case 'daily_calendar': {
      const date = zonedDateParts(new Date(), config.tz);
      return `${date.month}月${date.day}日`;
    }
    case 'month_calendar': {
      const date = zonedDateParts(new Date(), config.tz);
      return `${date.year}年${date.month}月`;
    }
    case 'weather':
      return config.location_label ? `${config.location_label}天气` : '天气';
    case 'history_today': {
      const date = zonedDateParts(new Date(), config.tz);
      return `历史上的${date.month}月${date.day}日`;
    }
    case 'weather_alert':
      return `${normalizeWeatherAlertProvince(config.province) || '全国'}气象预警`;
    case 'earthquake_report':
      return '地震速报';
    case 'dashboard':
      return dashboardStatusTitle(config);
    case 'font_test':
      return FONT_TEST_FONTS.find((font) => font.id === config.font_id)?.label ?? '字体测试';
    case 'hot_list':
      return `${hotListSourceShortLabel(config.source)}热榜`;
  }
}

export function dashboardStatusTitle(config: DashboardConfigT): string {
  if (config.template.kind === 'system') {
    return DASHBOARD_SYSTEM_TEMPLATES[config.template.id].label;
  }
  return config.template.template.name?.trim() || '自定义模板';
}
