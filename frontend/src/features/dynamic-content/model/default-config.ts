import type { DynamicConfigT, DynamicTypeT } from 'shared';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function defaultConfig(type: DynamicTypeT): DynamicConfigT {
  switch (type) {
    case 'daily_calendar':
      return { type: 'daily_calendar', tz: TZ };
    case 'month_calendar':
      return {
        type: 'month_calendar',
        tz: TZ,
      };
    case 'weather':
      return {
        type: 'weather',
        tz: TZ,
        provider: 'qweather',
        location_id: '101010100',
        location_label: '北京',
      };
    case 'history_today':
      return { type: 'history_today', tz: TZ };
    case 'dashboard':
      return { type: 'dashboard', layout: 'metrics' };
    case 'font_test':
      return {
        type: 'font_test',
        font_id: 'fusion_pixel_12',
        invert: false,
      };
  }
}
