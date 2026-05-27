import type { DynamicConfigT, DynamicTypeT } from 'shared';
import type { AllContentType } from './content-create-types';
import {
  dashboardStatusTitle,
  dynamicStatusTitle,
} from '@/features/dynamic-content/model/status-title';

export function defaultFrameName(type: DynamicTypeT, config: DynamicConfigT): string {
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

export function effectiveFrameName(
  type: AllContentType | null,
  config: DynamicConfigT,
  frameName: string
): string | null {
  if (!type || type === 'image') return frameName.trim() || null;
  if (type === 'dashboard') {
    return frameName.trim() || defaultFrameName(type, config);
  }
  return defaultFrameName(type, config);
}

export function effectiveStatusBarText(
  type: AllContentType | null,
  config: DynamicConfigT | null,
  frameName: string
): string | null {
  if (type === 'dashboard') {
    return (
      frameName.trim() ||
      (config?.type === 'dashboard' ? dashboardStatusTitle(config) : '外部数据')
    );
  }
  return dynamicStatusTitle(config);
}
