import { hotListSourceLabel, type HotListSourceIdT } from 'shared';
import { fetchJson } from './fetch';
import type { HotListSource } from './hot-list.types';
import { compactHot, withRanks } from './text';

const DAILY_HOT_API_BASE = 'https://api-hot.imsyy.top';
const NEXT_DAILY_HOT_BASE = 'https://hot.baiwumm.com/api';
const NEWSNOW_API = 'https://newsnow.busiyi.world/api/s';

const DAILY_HOT_API_SOURCE_IDS = [
  '51cto',
  '52pojie',
  'acfun',
  'csdn',
  'coolapk',
  'dgtle',
  'douban-group',
  'douban-movie',
  'gameres',
  'geekpark',
  'guokr',
  'hackernews',
  'hostloc',
  'huxiu',
  'ifanr',
  'ithome-xijiayi',
  'jianshu',
  'linuxdo',
  'miyoushe',
  'netease-news',
  'newsmth',
  'ngabbs',
  'nodeseek',
  'nytimes',
  'producthunt',
  'qq-news',
  'sina',
  'sina-news',
  'weread',
  'yystv',
  'zhihu-daily',
] as const satisfies readonly HotListSourceIdT[];

const NEXT_DAILY_HOT_SOURCE_IDS = [
  'baidutieba',
  'dongchedi',
  'douban-movic',
  'hello-github',
  'netease',
  'netease-music',
  'qq',
  'quark',
  'woshipm',
  'xiaohongshu',
] as const satisfies readonly HotListSourceIdT[];

const NEWSNOW_SOURCE_IDS = [
  '36kr-quick',
  'bilibili-hot-search',
  'bilibili-hot-video',
  'bilibili-ranking',
  'cankaoxiaoxi',
  'douban',
  'chongbuluo',
  'chongbuluo-hot',
  'chongbuluo-latest',
  'cls',
  'cls-depth',
  'cls-hot',
  'cls-telegraph',
  'fastbull',
  'fastbull-express',
  'fastbull-news',
  'freebuf',
  'gelonghui',
  'ifeng',
  'iqiyi',
  'iqiyi-hot-ranklist',
  'jin10',
  'kaopu',
  'mktnews',
  'mktnews-flash',
  'nowcoder',
  'pcbeta',
  'pcbeta-windows11',
  'solidot',
  'sputniknewscn',
  'steam',
  'tencent',
  'tencent-hot',
  'v2ex-share',
  'wallstreetcn',
  'wallstreetcn-hot',
  'wallstreetcn-news',
  'wallstreetcn-quick',
  'xueqiu',
  'xueqiu-hotstock',
  'zaobao',
  'qqvideo',
  'qqvideo-tv-hotsearch',
] as const satisfies readonly HotListSourceIdT[];

interface StandardApiItem {
  title?: unknown;
  desc?: unknown;
  author?: unknown;
  hot?: unknown;
  timestamp?: unknown;
  url?: unknown;
  mobileUrl?: unknown;
}

interface StandardApiResponse {
  data?: StandardApiItem[];
}

interface NewsNowItem {
  title?: unknown;
  url?: unknown;
  mobileUrl?: unknown;
  pubDate?: unknown;
  extra?: {
    hover?: unknown;
    date?: unknown;
    info?: unknown;
  };
}

interface NewsNowResponse {
  items?: NewsNowItem[];
}

export const REFERENCE_HOT_LIST_SOURCES: readonly HotListSource[] = [
  ...createStandardApiSources(DAILY_HOT_API_BASE, DAILY_HOT_API_SOURCE_IDS),
  ...createStandardApiSources(NEXT_DAILY_HOT_BASE, NEXT_DAILY_HOT_SOURCE_IDS),
  ...createNewsNowSources(NEWSNOW_SOURCE_IDS),
];

function createStandardApiSources(
  baseUrl: string,
  ids: readonly HotListSourceIdT[]
): HotListSource[] {
  return ids.map((id) => ({
    id,
    label: hotListSourceLabel(id),
    async fetch(ctx) {
      const json = await fetchJson<StandardApiResponse>(`${baseUrl}/${id}`, {
        signal: ctx.signal,
      });
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: stringValue(item.title) ?? '',
          desc: stringValue(item.desc),
          author: stringValue(item.author),
          hot: compactHot(item.hot),
          timestamp: stringValue(item.timestamp),
          url: firstString(item.url, item.mobileUrl),
        }))
      );
    },
  }));
}

function createNewsNowSources(ids: readonly HotListSourceIdT[]): HotListSource[] {
  return ids.map((id) => ({
    id,
    label: hotListSourceLabel(id),
    async fetch(ctx) {
      const url = `${NEWSNOW_API}?id=${encodeURIComponent(id)}&latest=true`;
      const json = await fetchJson<NewsNowResponse>(url, { signal: ctx.signal });
      return withRanks(
        (json.items ?? []).map((item) => ({
          title: stringValue(item.title) ?? '',
          desc: stringValue(item.extra?.hover),
          author: typeof item.extra?.info === 'string' ? item.extra.info : undefined,
          timestamp: stringValue(item.extra?.date ?? item.pubDate),
          url: firstString(item.url, item.mobileUrl),
        }))
      );
    },
  }));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}
