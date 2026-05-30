import { afterEach, describe, expect, it } from 'bun:test';
import { NEWSNOW_DIRECT_SOURCES } from './newsnow-direct';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('NEWSNOW_DIRECT_SOURCES', () => {
  it('fetches cls telegraph items from the current roll list endpoint', async () => {
    const source = NEWSNOW_DIRECT_SOURCES.find((item) => item.id === 'cls-telegraph');
    if (!source) throw new Error('missing cls-telegraph source');

    let requestedUrl = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return Response.json({
        errno: 0,
        data: {
          roll_data: [
            {
              id: 2385539,
              title: '芯联集成：4500V超高压IGBT产品进入大范围推广',
              brief: '财联社5月29日电，芯联集成在互动平台表示...',
              ctime: 1780047296,
              is_ad: 0,
            },
            {
              id: 1,
              title: '广告',
              is_ad: 1,
            },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const data = await source.fetch({ signal: new AbortController().signal });

    expect(requestedUrl.startsWith('https://www.cls.cn/v1/roll/get_roll_list?')).toBe(true);
    expect(requestedUrl).toContain('app=CailianpressWeb');
    expect(requestedUrl).toContain('sv=8.7.9');
    expect(requestedUrl).toContain('sign=');
    expect(data).toEqual([
      {
        rank: 1,
        title: '芯联集成：4500V超高压IGBT产品进入大范围推广',
        timestamp: '2026-05-29T09:34:56.000Z',
        url: 'https://www.cls.cn/detail/2385539',
      },
    ]);
  });

  it('parses every sputnik timeline item instead of only the first one', async () => {
    const source = NEWSNOW_DIRECT_SOURCES.find((item) => item.id === 'sputniknewscn');
    if (!source) throw new Error('missing sputniknewscn source');

    globalThis.fetch = (async () => {
      return new Response(`
        <div class="lenta__item ">
          <a href="/20260529/1071578180.html" class="lenta__item-size">
            <span class="lenta__item-date " data-unixtime="1780047758"></span>
            <span class="lenta__item-text ">第一条快讯</span>
          </a>
        </div>
        <div class="lenta__item ">
          <a href="/20260529/1071578061.html" class="lenta__item-size">
            <span class="lenta__item-date " data-unixtime="1780047565"></span>
            <span class="lenta__item-text ">第二条快讯</span>
          </a>
        </div>
      `);
    }) as unknown as typeof fetch;

    const data = await source.fetch({ signal: new AbortController().signal });

    expect(data.map((item) => item.title)).toEqual(['第一条快讯', '第二条快讯']);
    expect(data.map((item) => item.url)).toEqual([
      'https://sputniknews.cn/20260529/1071578180.html',
      'https://sputniknews.cn/20260529/1071578061.html',
    ]);
  });
});
