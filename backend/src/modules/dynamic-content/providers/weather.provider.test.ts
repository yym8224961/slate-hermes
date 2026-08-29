import { afterEach, describe, expect, it } from 'bun:test';
import type { QweatherConfig } from './qweather.config';
import {
  forecastLabel,
  mapWttrCode,
  translateWindDirection,
  WeatherProvider,
} from './weather.provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('forecastLabel', () => {
  it('maps wttr thunder and all 16-point wind directions to display-safe Chinese', () => {
    expect(mapWttrCode('200')).toBe(302);
    expect(translateWindDirection('NNE')).toBe('北东北风');
    expect(translateWindDirection('WSW')).toBe('西南西风');
    expect(translateWindDirection('东南')).toBe('东南风');
  });

  it('labels forecast dates across year boundaries', () => {
    const now = new Date('2026-12-31T04:00:00.000Z');

    expect(forecastLabel('2027-01-01', 'Asia/Shanghai', now)).toBe('明日');
    expect(forecastLabel('2027-01-02', 'Asia/Shanghai', now)).toBe('后天');
  });

  it('searches QWeather cities and maps safe response fields', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return Response.json({
        code: '200',
        location: [
          { id: '101250101', name: '长沙', adm1: '湖南省', adm2: '长沙市' },
          { id: '', name: 'invalid', adm1: '湖南省', adm2: '长沙市' },
        ],
      });
    }) as unknown as typeof fetch;

    const provider = new WeatherProvider({
      apiKey: 'key',
      apiHost: 'https://weather.example',
    } as QweatherConfig);

    await expect(provider.searchCities('长沙', 8, 1)).resolves.toEqual([
      { id: '101250101', name: '长沙', adm1: '湖南省', adm2: '长沙市' },
    ]);
    expect(requestedUrl).toContain('/geo/v2/city/lookup');
    expect(requestedUrl).toContain('location=%E9%95%BF%E6%B2%99');
    expect(requestedUrl).toContain('number=8');
  });

  it('does not reuse stale last-data fallback when QWeather is not configured', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('weather upstream unavailable');
    }) as unknown as typeof fetch;
    const provider = new WeatherProvider({
      apiKey: '',
      apiHost: '',
    } as QweatherConfig);
    const config = provider.validateConfig({
      type: 'weather',
      tz: 'Asia/Shanghai',
      provider: 'qweather',
      location_id: '101250101',
      location_label: '长沙',
      refresh_interval_sec: 600,
    });

    await expect(
      provider.fetchData(config, {
        now: new Date('2026-05-18T00:00:00.000Z'),
        lastData: {
          tempC: 21,
          summary: '晴',
          updatedAt: '2026-05-17T00:00:00.000Z',
        },
      })
    ).rejects.toThrow();
  });

  it('uses the no-key public weather fallback with the selected city label', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return Response.json({
        nearest_area: [
          {
            areaName: [{ value: 'Changsha' }],
            region: [{ value: 'Hunan' }],
            latitude: '28.2',
            longitude: '112.967',
          },
        ],
        current_condition: [
          {
            temp_C: '23',
            FeelsLikeC: '27',
            humidity: '93',
            pressure: '999',
            winddir16Point: '东南',
            windspeedKmph: '8',
            weatherCode: '176',
            weatherDesc: [{ value: 'Patchy rain nearby' }],
          },
        ],
        weather: [
          {
            date: '2026-05-17',
            maxtempC: '30',
            mintempC: '23',
            hourly: [{ weatherCode: '176', weatherDesc: [{ value: 'Patchy rain nearby' }] }],
          },
          {
            date: '2026-05-18',
            maxtempC: '31',
            mintempC: '24',
            hourly: [{ weatherCode: '113', weatherDesc: [{ value: 'Sunny' }] }],
          },
          {
            date: '2026-05-19',
            maxtempC: '32',
            mintempC: '25',
            hourly: [{ weatherCode: '116', weatherDesc: [{ value: 'Partly cloudy' }] }],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const provider = new WeatherProvider({ apiKey: '', apiHost: '' } as QweatherConfig);
    const config = provider.validateConfig({
      type: 'weather',
      tz: 'Asia/Shanghai',
      provider: 'qweather',
      location_id: '长沙',
      location_label: '长沙',
      refresh_interval_sec: 600,
    });

    await expect(
      provider.fetchData(config, { now: new Date('2026-05-17T04:00:00.000Z') })
    ).resolves.toMatchObject({
      tempC: 23,
      feelsLikeC: 27,
      humidity: 93,
      summary: '阵雨',
      fc: [
        { label: '今日', tempMin: 23, tempMax: 30 },
        { label: '明日', tempMin: 24, tempMax: 31 },
        { label: '后天', tempMin: 25, tempMax: 32 },
      ],
    });
    expect(requestedUrl).toContain('wttr.in/%E9%95%BF%E6%B2%99?format=j1');
  });

  it('returns no city-search error when QWeather is not configured', async () => {
    const provider = new WeatherProvider({ apiKey: '', apiHost: '' } as QweatherConfig);

    await expect(provider.searchCities('长沙')).resolves.toEqual([]);
  });
});
