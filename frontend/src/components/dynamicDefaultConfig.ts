import { type DynamicConfigT, type DynamicTypeT } from 'shared';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function defaultConfig(type: DynamicTypeT): DynamicConfigT {
  switch (type) {
    case 'date':
      return { type: 'date', tz: TZ, show_lunar: true, show_solar_term: true };
    case 'weather':
      return {
        type: 'weather',
        tz: TZ,
        provider: 'qweather',
        location_id: '101010100',
        location_label: '北京',
        units: 'metric',
      };
    case 'history_today':
      return { type: 'history_today', tz: TZ };
    case 'dashboard':
      return { type: 'dashboard', layout: 'metrics' };
  }
}
