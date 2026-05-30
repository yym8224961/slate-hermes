import { afterEach, describe, expect, it } from 'bun:test';
import type { QweatherConfig } from './qweather.config';
import { forecastLabel, WeatherProvider } from './weather.provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('forecastLabel', () => {
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
    ).rejects.toThrow('QWEATHER_API_KEY 未配置');
  });
});
