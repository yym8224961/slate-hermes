import { afterEach, describe, expect, it } from 'bun:test';
import { WeatherAlertProvider } from './weather-alert.provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WeatherAlertProvider', () => {
  it('normalizes province aliases before calling NMC', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return jsonResponse({
        data: {
          page: {
            list: [
              {
                alertid: '1',
                issuetime: '2026/05/25 08:00',
                title: '湖南省长沙市气象台发布暴雨黄色预警信号',
                url: '/publish/alarm/1.html',
              },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;

    const provider = new WeatherAlertProvider();
    const config = provider.validateConfig({
      type: 'weather_alert',
      province: '湖南',
      refresh_interval_sec: 600,
    });
    const data = await provider.fetchData(config, {
      now: new Date('2026-05-25T00:00:00.000Z'),
    });

    expect(decodeURIComponent(requestedUrl)).toContain('province=湖南省');
    expect(data.title).toBe('湖南省气象预警');
    expect(data.province).toBe('湖南省');
    expect(requestedUrl.startsWith('https://www.nmc.cn/rest/findAlarm')).toBe(true);
    expect(data.items[0]?.url).toBe('https://www.nmc.cn/publish/alarm/1.html');
  });

  it('shares cache entries between aliases and official province names', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        data: {
          page: {
            list: [],
          },
        },
      });
    }) as unknown as typeof fetch;

    const provider = new WeatherAlertProvider();
    const shortConfig = provider.validateConfig({
      type: 'weather_alert',
      province: '广西',
      refresh_interval_sec: 600,
    });
    const officialConfig = provider.validateConfig({
      type: 'weather_alert',
      province: '广西壮族自治区',
      refresh_interval_sec: 600,
    });

    await provider.fetchData(shortConfig, { now: new Date('2026-05-25T00:00:00.000Z') });
    await provider.fetchData(officialConfig, { now: new Date('2026-05-25T00:05:00.000Z') });

    expect(calls).toBe(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
