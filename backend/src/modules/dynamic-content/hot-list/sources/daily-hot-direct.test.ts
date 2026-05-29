import { afterEach, describe, expect, it } from 'bun:test';
import { DAILY_HOT_DIRECT_SOURCES } from './daily-hot-direct';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('DAILY_HOT_DIRECT_SOURCES', () => {
  it('fetches jianshu items from the JSON trending endpoint', async () => {
    const source = DAILY_HOT_DIRECT_SOURCES.find((item) => item.id === 'jianshu');
    if (!source) throw new Error('missing jianshu source');

    let requestedUrl = '';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return Response.json([
        {
          object: {
            type: 1,
            data: {
              title: 'Android 自定义编译时注解（APT）',
              slug: '29cb1641f24b',
              public_abbr: 'APT 即为 Annotation Processing Tool',
              likes_count: 15,
              user: { nickname: '三十五岁养老' },
            },
          },
        },
        {
          object: {
            type: 2,
            data: {
              title: '非文章条目',
              slug: 'ignored',
            },
          },
        },
      ]);
    }) as unknown as typeof fetch;

    const data = await source.fetch({ signal: new AbortController().signal });

    expect(requestedUrl).toBe('https://www.jianshu.com/asimov/trending/now');
    expect(data).toEqual([
      {
        rank: 1,
        title: 'Android 自定义编译时注解（APT）',
        desc: 'APT 即为 Annotation Processing Tool',
        author: '三十五岁养老',
        hot: '15喜欢',
        url: 'https://www.jianshu.com/p/29cb1641f24b',
      },
    ]);
  });

  it('extends zhihu daily with older pages when latest has too few stories', async () => {
    const source = DAILY_HOT_DIRECT_SOURCES.find((item) => item.id === 'zhihu-daily');
    if (!source) throw new Error('missing zhihu-daily source');

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/api/4/news/latest')) {
        return Response.json({
          date: '20260529',
          stories: Array.from({ length: 29 }, (_, index) => ({
            id: `latest-${index}`,
            type: 0,
            title: `今日故事 ${index + 1}`,
            hint: '知乎日报',
            url: `https://daily.zhihu.com/story/latest-${index}`,
          })),
        });
      }
      return Response.json({
        date: '20260528',
        stories: [
          {
            id: 'older-1',
            type: 0,
            title: '昨日故事',
            hint: '知乎日报',
            url: 'https://daily.zhihu.com/story/older-1',
          },
          {
            id: 'ad-1',
            type: 1,
            title: '非普通故事',
            url: 'https://daily.zhihu.com/story/ad-1',
          },
          {
            id: 'older-2',
            type: 0,
            title: '前日故事',
            hint: '知乎日报',
            url: 'https://daily.zhihu.com/story/older-2',
          },
        ],
      });
    }) as unknown as typeof fetch;

    const data = await source.fetch({ signal: new AbortController().signal });

    expect(requestedUrls).toEqual([
      'https://daily.zhihu.com/api/4/news/latest',
      'https://daily.zhihu.com/api/4/news/before/20260529',
    ]);
    expect(data).toHaveLength(31);
    expect(data.at(-2)?.title).toBe('昨日故事');
    expect(data.at(-1)?.title).toBe('前日故事');
  });
});
