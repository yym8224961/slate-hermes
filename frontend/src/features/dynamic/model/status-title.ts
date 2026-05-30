import {
  DASHBOARD_SYSTEM_TEMPLATES,
  FONT_TEST_FONTS,
  hotListSourceShortLabel,
  normalizeWeatherAlertProvince,
  type DashboardConfigT,
  type DynamicConfigT,
} from 'shared';
import { zonedDateParts } from './date';

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
