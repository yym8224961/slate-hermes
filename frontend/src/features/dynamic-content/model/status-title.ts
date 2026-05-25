import {
  FONT_TEST_FONTS,
  hotListSourceShortLabel,
  normalizeWeatherAlertProvince,
  type DynamicConfigT,
} from 'shared';

export function dynamicStatusTitle(config: DynamicConfigT | null | undefined): string | null {
  if (!config) return null;
  const now = new Date();
  switch (config.type) {
    case 'daily_calendar':
      return `${dateParts(now, config.tz).month}月${dateParts(now, config.tz).day}日`;
    case 'month_calendar':
      return `${dateParts(now, config.tz).year}年${dateParts(now, config.tz).month}月`;
    case 'history_today':
      return `历史上的${dateParts(now, config.tz).month}月${dateParts(now, config.tz).day}日`;
    case 'weather_alert':
      return `${normalizeWeatherAlertProvince(config.province) || '全国'}气象预警`;
    case 'earthquake_report':
      return '地震速报';
    case 'weather':
      return config.location_label ? `${config.location_label}天气` : '天气';
    case 'dashboard':
      return '数据看板';
    case 'font_test':
      return FONT_TEST_FONTS.find((font) => font.id === config.font_id)?.label ?? '字体测试';
    case 'hot_list':
      return `${hotListSourceShortLabel(config.source)}热榜`;
    default:
      return null;
  }
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value ?? 1970),
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 1),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 1),
  };
}
