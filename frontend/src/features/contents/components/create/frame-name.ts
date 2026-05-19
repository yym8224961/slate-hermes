import type { DynamicConfigT, DynamicTypeT } from 'shared';
import type { AllContentType } from './content-create-types';
import { dynamicStatusTitle } from '@/features/dynamic-content/model/status-title';

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
    case 'dashboard':
      return '数据看板';
    case 'font_test':
      return dynamicStatusTitle(config) ?? '字体测试';
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
  if (type === 'dashboard') return frameName.trim() || '数据看板';
  return dynamicStatusTitle(config);
}

export function hasVisibleDynamicConfig(config: DynamicConfigT): boolean {
  return !['daily_calendar', 'month_calendar', 'history_today'].includes(config.type);
}
