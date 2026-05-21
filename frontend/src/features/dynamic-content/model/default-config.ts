import { DEFAULT_TTS_VOICE, type DynamicConfigT, type DynamicTypeT } from 'shared';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function defaultConfig(type: DynamicTypeT): DynamicConfigT {
  switch (type) {
    case 'daily_calendar':
      return {
        type: 'daily_calendar',
        tz: TZ,
        audio_enabled: false,
        audio_voice: DEFAULT_TTS_VOICE,
      };
    case 'month_calendar':
      return {
        type: 'month_calendar',
        tz: TZ,
        audio_enabled: false,
        audio_voice: DEFAULT_TTS_VOICE,
      };
    case 'weather':
      return {
        type: 'weather',
        tz: TZ,
        provider: 'qweather',
        location_id: '101010100',
        location_label: '北京',
        audio_enabled: false,
        audio_voice: DEFAULT_TTS_VOICE,
        refresh_interval_sec: 600,
      };
    case 'history_today':
      return {
        type: 'history_today',
        tz: TZ,
        audio_enabled: false,
        audio_voice: DEFAULT_TTS_VOICE,
      };
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
