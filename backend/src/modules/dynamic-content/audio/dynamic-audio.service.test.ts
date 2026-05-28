import { describe, expect, it } from 'bun:test';
import { DEFAULT_TTS_VOICE } from 'shared';
import type { AppConfig } from '../../../infra/config/app.config';
import type { BlobService } from '../../../infra/blob/blob.service';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { GroupsService } from '../../groups/groups.service';
import type { TtsService } from '../../tts/tts.service';
import { buildDynamicAudioTextForContent, DynamicAudioService } from './dynamic-audio.service';

describe('DynamicAudioService', () => {
  it('clears its scheduled timer on module destroy', () => {
    const service = new DynamicAudioService(
      {} as PrismaService,
      {} as BlobService,
      { backgroundWorkers: true } as AppConfig,
      {} as GroupsService,
      {} as TtsService
    );

    service.onModuleInit();
    expect((service as unknown as { timer: unknown }).timer).not.toBeNull();

    service.onModuleDestroy();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });
});

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

  it('weather_alert summarizes current warnings', () => {
    const text = buildDynamicAudioTextForContent(
      'weather_alert',
      {
        type: 'weather_alert',
        province: '',
        refresh_interval_sec: 600,
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        province: '',
        items: [
          {
            title: '中央气象台发布暴雨黄色预警',
            issuedAt: '2026-05-21T02:00:00.000Z',
          },
          {
            title: '广东省发布雷雨大风蓝色预警信号',
            issuedAt: '2026-05-21T01:00:00.000Z',
          },
          {
            title: '四川省发布高温橙色预警',
            issuedAt: '2026-05-21T00:00:00.000Z',
          },
          {
            title: '浙江省发布大雾黄色预警',
            issuedAt: '2026-05-20T23:00:00.000Z',
          },
        ],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe(
      '全国气象预警，播报最新三条。中央气象台发布暴雨黄色预警。广东发布雷雨大风蓝色预警。四川发布高温橙色预警'
    );
  });

  it('weather_alert reports the actual warning count', () => {
    const text = buildDynamicAudioTextForContent(
      'weather_alert',
      {
        type: 'weather_alert',
        province: '广东省',
        refresh_interval_sec: 600,
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        province: '广东省',
        items: [
          {
            title: '广东省发布雷雨大风蓝色预警信号',
            issuedAt: '2026-05-21T01:00:00.000Z',
          },
        ],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe('广东气象预警，播报最新一条。广东发布雷雨大风蓝色预警');
  });

  it('earthquake_report summarizes latest reports', () => {
    const text = buildDynamicAudioTextForContent(
      'earthquake_report',
      {
        type: 'earthquake_report',
        refresh_interval_sec: 600,
        audio_enabled: true,
        audio_voice: DEFAULT_TTS_VOICE,
      },
      {
        items: [
          {
            occurredAt: '2026-05-21 11:27:06',
            magnitude: '4.1',
            depthKm: '10',
            location: '青海海西州唐古拉地区',
          },
          {
            occurredAt: '2026-05-21 01:16:27',
            magnitude: '3.2',
            depthKm: '-',
            location: '山西大同市云冈区',
          },
          {
            occurredAt: '2026-05-20 23:08:44',
            magnitude: '3.6',
            depthKm: '8',
            location: '四川雅安市石棉县',
          },
          {
            occurredAt: '2026-05-20 19:42:10',
            magnitude: '4.8',
            depthKm: '12',
            location: '台湾花莲县海域',
          },
        ],
      },
      new Date('2026-05-21T10:00:00+08:00')
    );

    expect(text).toBe(
      '中国地震台网最新速报。最新一条，青海海西州唐古拉地区。震级4.1级。震源深度10千米。发生时间5月21日11点27分。其余三条：山西大同市云冈区，震级3.2级；四川雅安市石棉县，震级3.6级；台湾花莲县海域，震级4.8级'
    );
  });
});
