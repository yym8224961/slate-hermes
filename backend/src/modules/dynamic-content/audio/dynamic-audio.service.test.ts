import { describe, expect, it } from 'bun:test';
import { DEFAULT_TTS_VOICE } from 'shared';
import { buildDynamicAudioTextForContent } from './dynamic-audio.service';

describe('buildDynamicAudioTextForContent', () => {
  it('daily_calendar omits yi/ji and skips festival when absent', () => {
    const text = buildDynamicAudioTextForContent(
      'daily_calendar',
      {
        type: 'daily_calendar',
        tz: 'Asia/Shanghai',
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        month: '5',
        day: '21',
        weekdayCN: '星期四',
        lunarDate: '农历四月初五',
        solarTerm: '小满',
        festival: null,
        yi: ['开光', '纳采', '裁衣'],
        ji: ['嫁娶', '栽种', '修造'],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe('今天是5月21日，星期四。农历四月初五。今日节气小满');
    expect(text).not.toContain('宜');
    expect(text).not.toContain('忌');
  });

  it('month_calendar skips festival when absent', () => {
    const text = buildDynamicAudioTextForContent(
      'month_calendar',
      {
        type: 'month_calendar',
        tz: 'Asia/Shanghai',
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        calendar: {
          months: {
            '2026-05': {
              days: {
                '2026-05-21': {
                  lunar_date: '农历四月初五',
                  solar_term: '小满',
                  festival: null,
                },
              },
            },
          },
        },
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe('现在是2026年5月。今天5月21日。农历四月初五。今日节气小满');
  });

  it('weather omits future forecast', () => {
    const text = buildDynamicAudioTextForContent(
      'weather',
      {
        type: 'weather',
        tz: 'Asia/Shanghai',
        provider: 'qweather',
        location_id: '101010100',
        location_label: '北京',
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
        refresh_interval_sec: 600,
      },
      {
        summary: '晴',
        tempC: 26,
        feelsLikeC: 27,
        humidity: 35,
        windDisplay: '东南风2级',
        fc: [
          { label: '今日', val: '晴  18~30°' },
          { label: '明日', val: '多云  19~31°' },
          { label: '后天', val: '阴  20~28°' },
        ],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe('北京今天天气，晴。26度。体感27度。湿度35%。东南风2级');
    expect(text).not.toContain('未来三天');
  });

  it('history_today speaks years as years instead of bare numbers', () => {
    const text = buildDynamicAudioTextForContent(
      'history_today',
      {
        type: 'history_today',
        tz: 'Asia/Shanghai',
        source: 'wikipedia',
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        dateLabel: '5月21日',
        items: [
          { year: '前221', display: '秦统一六国，建立中国历史上首个统一王朝' },
          { year: '1904', display: '国际足联在巴黎成立，现代足球治理体系成形' },
        ],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe(
      '历史上的5月21日。公元1904年，国际足联在巴黎成立，现代足球治理体系成形。公元前221年，秦统一六国，建立中国历史上首个统一王朝'
    );
  });

  it('history_today rejects non-current payloads', () => {
    const text = buildDynamicAudioTextForContent(
      'history_today',
      {
        type: 'history_today',
        tz: 'Asia/Shanghai',
        source: 'wikipedia',
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        dateLabel: '5月21日',
        entries: [{ year: '1904', display: '国际足联在巴黎成立' }],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe('');
  });
});
