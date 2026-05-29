import { describe, expect, it } from 'bun:test';
import { HotListProvider } from './hot-list.provider';
import type { HotListItem, HotListSource } from '../hot-list/hot-list.types';

describe('HotListProvider', () => {
  it('validates config defaults', () => {
    const provider = new HotListProvider();
    const config = provider.validateConfig({ type: 'hot_list' });
    expect(config.source).toBe('weibo');
    expect('item_count' in config).toBe(false);
    expect(config.refresh_interval_sec).toBe(600);
  });

  it('rejects unknown sources', () => {
    const provider = new HotListProvider();
    expect(() => provider.validateConfig({ type: 'hot_list', source: 'missing' })).toThrow();
  });

  it('normalizes legacy source ids', () => {
    const provider = new HotListProvider();
    const wallstreet = provider.validateConfig({ type: 'hot_list', source: 'wallstreetcn' });
    const qqVideo = provider.validateConfig({ type: 'hot_list', source: 'qqvideo' });

    expect(wallstreet.source).toBe('wallstreetcn-quick');
    expect(qqVideo.source).toBe('qqvideo-tv-hotsearch');
  });

  it('caches fetched lists within the configured refresh ttl', async () => {
    let calls = 0;
    const source: HotListSource = {
      id: 'weibo',
      label: '微博',
      fetch: async (): Promise<HotListItem[]> => {
        calls += 1;
        return [{ rank: 1, title: `缓存测试 ${calls}` }];
      },
    };
    const provider = new HotListProvider([source]);
    const config = provider.validateConfig({
      type: 'hot_list',
      source: 'weibo',
      refresh_interval_sec: 600,
    });

    const first = await provider.fetchData(config, { now: new Date('2026-05-17T04:00:00.000Z') });
    const second = await provider.fetchData(config, { now: new Date('2026-05-17T04:05:00.000Z') });
    const third = await provider.fetchData(config, { now: new Date('2026-05-17T04:11:00.000Z') });

    expect(calls).toBe(2);
    expect(second.items[0]?.title).toBe(first.items[0]?.title);
    expect(third.items[0]?.title).toBe('缓存测试 2');
  });

  it('returns an empty first-run payload when a source is temporarily unavailable', async () => {
    const source: HotListSource = {
      id: 'douyin',
      label: '抖音',
      fetch: async (): Promise<HotListItem[]> => {
        throw new Error('source down');
      },
    };
    const provider = new HotListProvider([source]);
    const config = provider.validateConfig({
      type: 'hot_list',
      source: 'douyin',
      refresh_interval_sec: 600,
    });

    const data = await provider.fetchData(config, { now: new Date('2026-05-17T04:00:00.000Z') });
    expect(data.source).toBe('douyin');
    expect(data.sourceLabel).toBe('抖音');
    expect(data.items).toEqual([]);
  });

  it('drops unsafe upstream item URLs before returning hot-list data', async () => {
    const source: HotListSource = {
      id: 'v2ex',
      label: 'V2EX',
      fetch: async (): Promise<HotListItem[]> => [
        { rank: 1, title: 'safe', url: 'https://www.v2ex.com/t/1' },
        { rank: 2, title: 'script', url: 'javascript:alert(1)' },
        { rank: 3, title: 'file', url: 'file:///etc/passwd' },
        { rank: 4, title: 'local', url: 'http://127.0.0.1/admin' },
      ],
    };
    const provider = new HotListProvider([source]);
    const config = provider.validateConfig({
      type: 'hot_list',
      source: 'v2ex',
      refresh_interval_sec: 600,
    });

    const data = await provider.fetchData(config, { now: new Date('2026-05-17T04:00:00.000Z') });

    expect(data.items.map((item) => item.url)).toEqual([
      'https://www.v2ex.com/t/1',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('applies per-content last-data fallback when concurrent fetches share one failed request', async () => {
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let calls = 0;
    const source: HotListSource = {
      id: 'zhihu',
      label: '知乎',
      fetch: async (): Promise<HotListItem[]> => {
        calls += 1;
        await blocked;
        throw new Error('source down');
      },
    };
    const provider = new HotListProvider([source]);
    const config = provider.validateConfig({
      type: 'hot_list',
      source: 'zhihu',
      refresh_interval_sec: 600,
    });

    const first = provider.fetchData(config, {
      now: new Date('2026-05-17T04:00:00.000Z'),
      lastData: {
        source: 'zhihu',
        sourceLabel: '知乎',
        updatedAt: '2026-05-17T03:45:00.000Z',
        items: [{ rank: 1, title: '第一份旧数据' }],
      },
    });
    const second = provider.fetchData(config, {
      now: new Date('2026-05-17T04:00:00.000Z'),
      lastData: {
        source: 'zhihu',
        sourceLabel: '知乎',
        updatedAt: '2026-05-17T03:45:00.000Z',
        items: [{ rank: 1, title: '第二份旧数据' }],
      },
    });

    releaseFetch();
    const [firstData, secondData] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(firstData.items[0]?.title).toBe('第一份旧数据');
    expect(secondData.items[0]?.title).toBe('第二份旧数据');
  });

  it('does not reuse stale last-data fallback after source fetch failure', async () => {
    const source: HotListSource = {
      id: 'zhihu',
      label: '知乎',
      fetch: async (): Promise<HotListItem[]> => {
        throw new Error('source down');
      },
    };
    const provider = new HotListProvider([source]);
    const config = provider.validateConfig({
      type: 'hot_list',
      source: 'zhihu',
      refresh_interval_sec: 600,
    });

    const data = await provider.fetchData(config, {
      now: new Date('2026-05-17T06:00:00.000Z'),
      lastData: {
        source: 'zhihu',
        sourceLabel: '知乎',
        updatedAt: '2026-05-17T03:00:00.000Z',
        items: [{ rank: 1, title: '过期旧数据' }],
      },
    });

    expect(data.items).toEqual([]);
  });
});
