import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DASHBOARD_SYSTEM_TEMPLATES,
  DEFAULT_TTS_VOICE,
  FONT_TEST_FONTS,
  hotListSourceShortLabel,
  normalizeWeatherAlertProvince,
  type DashboardConfigT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

interface DynamicTypeDefinition {
  type: DynamicTypeT;
  defaultConfig: () => DynamicConfigT;
  statusTitle: (config: DynamicConfigT) => string | null;
  defaultFrameName: (config: DynamicConfigT) => string;
}

export const DYNAMIC_TYPE_REGISTRY = {
  daily_calendar: {
    type: 'daily_calendar',
    defaultConfig: () => ({
      type: 'daily_calendar',
      tz: TZ,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    }),
    statusTitle: (config) => {
      if (config.type !== 'daily_calendar') return null;
      const dp = dateParts(new Date(), config.tz);
      return `${dp.month}月${dp.day}日`;
    },
    defaultFrameName: () => '日历',
  },
  month_calendar: {
    type: 'month_calendar',
    defaultConfig: () => ({
      type: 'month_calendar',
      tz: TZ,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    }),
    statusTitle: (config) => {
      if (config.type !== 'month_calendar') return null;
      const dp = dateParts(new Date(), config.tz);
      return `${dp.year}年${dp.month}月`;
    },
    defaultFrameName: () => '月历',
  },
  weather: {
    type: 'weather',
    defaultConfig: () => ({
      type: 'weather',
      tz: TZ,
      provider: 'qweather',
      location_id: '101010100',
      location_label: '北京',
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
      refresh_interval_sec: 600,
    }),
    statusTitle: (config) =>
      config.type === 'weather' && config.location_label ? `${config.location_label}天气` : '天气',
    defaultFrameName: (config) =>
      config.type === 'weather' && config.location_label ? `${config.location_label}天气` : '天气',
  },
  history_today: {
    type: 'history_today',
    defaultConfig: () => ({
      type: 'history_today',
      tz: TZ,
      source: 'wikipedia',
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    }),
    statusTitle: (config) => {
      if (config.type !== 'history_today') return null;
      const dp = dateParts(new Date(), config.tz);
      return `历史上的${dp.month}月${dp.day}日`;
    },
    defaultFrameName: () => '历史上的今天',
  },
  weather_alert: {
    type: 'weather_alert',
    defaultConfig: () => ({
      type: 'weather_alert',
      province: '',
      refresh_interval_sec: 600,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    }),
    statusTitle: (config) =>
      config.type === 'weather_alert'
        ? `${normalizeWeatherAlertProvince(config.province) || '全国'}气象预警`
        : null,
    defaultFrameName: (config) => dynamicStatusTitle(config) ?? '气象预警',
  },
  earthquake_report: {
    type: 'earthquake_report',
    defaultConfig: () => ({
      type: 'earthquake_report',
      refresh_interval_sec: 600,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    }),
    statusTitle: () => '地震速报',
    defaultFrameName: () => '地震速报',
  },
  dashboard: {
    type: 'dashboard',
    defaultConfig: () => ({
      type: 'dashboard',
      template: { kind: 'custom', template: DASHBOARD_CUSTOM_STARTER_TEMPLATE },
      refresh_interval_sec: 600,
    }),
    statusTitle: (config) => (config.type === 'dashboard' ? dashboardStatusTitle(config) : null),
    defaultFrameName: (config) =>
      config.type === 'dashboard' ? dashboardStatusTitle(config) : '外部数据',
  },
  font_test: {
    type: 'font_test',
    defaultConfig: () => ({
      type: 'font_test',
      font_id: 'fusion_pixel_12',
      invert: false,
    }),
    statusTitle: (config) =>
      config.type === 'font_test'
        ? (FONT_TEST_FONTS.find((font) => font.id === config.font_id)?.label ?? '字体测试')
        : null,
    defaultFrameName: (config) => dynamicStatusTitle(config) ?? '字体测试',
  },
  hot_list: {
    type: 'hot_list',
    defaultConfig: () => ({
      type: 'hot_list',
      source: 'weibo',
      refresh_interval_sec: 600,
    }),
    statusTitle: (config) =>
      config.type === 'hot_list' ? `${hotListSourceShortLabel(config.source)}热榜` : null,
    defaultFrameName: (config) => dynamicStatusTitle(config) ?? '热榜',
  },
} satisfies Record<DynamicTypeT, DynamicTypeDefinition>;

export function defaultConfig(type: DynamicTypeT): DynamicConfigT {
  return DYNAMIC_TYPE_REGISTRY[type].defaultConfig();
}

export function dynamicStatusTitle(config: DynamicConfigT | null | undefined): string | null {
  if (!config) return null;
  return DYNAMIC_TYPE_REGISTRY[config.type].statusTitle(config);
}

export function defaultDynamicFrameName(type: DynamicTypeT, config: DynamicConfigT): string {
  return DYNAMIC_TYPE_REGISTRY[type].defaultFrameName(config);
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

export function dashboardStatusTitle(config: DashboardConfigT): string {
  if (config.template.kind === 'system') {
    return DASHBOARD_SYSTEM_TEMPLATES[config.template.id].label;
  }
  return config.template.template.name?.trim() || '自定义模板';
}

function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = getDatePartsFormatter(timeZone).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value ?? 1970),
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 1),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 1),
  };
}

const datePartsFormatters = new Map<string, Intl.DateTimeFormat>();

function getDatePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = datePartsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    datePartsFormatters.set(timeZone, formatter);
  }
  return formatter;
}
