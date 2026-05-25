import { hotListSourceLabel, type CurrentHotListSourceIdT } from 'shared';
import { DESKTOP_UA, fetchJson, fetchText } from './fetch';
import { firstMatch, htmlBlocks, jsonFromScript } from './html';
import type { HotListItem, HotListSource } from './hot-list.types';
import {
  compactHot,
  normalizeTimestamp,
  withRanks,
  type NeteaseResponse,
  type QqNewsResponse,
} from './text';

type ReferenceHotListSourceId =
  | 'dongchedi'
  | 'douban-movic'
  | 'hello-github'
  | 'netease'
  | 'netease-music'
  | 'qq'
  | 'quark'
  | 'woshipm'
  | 'xiaohongshu';

export const REFERENCE_HOT_LIST_SOURCES: readonly HotListSource[] = [
  source({
    id: 'dongchedi',
    async fetch(signal) {
      const html = await fetchText('https://www.dongchedi.com/news', {
        signal,
        headers: { Referer: 'https://www.dongchedi.com/', 'User-Agent': DESKTOP_UA },
      });
      const json = jsonFromScript<DongchediNextData>(
        html,
        /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
      );
      return withRanks(
        (json?.props?.pageProps?.hotSearchList ?? []).map((item) => ({
          title: item.title ?? '',
          hot: compactHot(item.score),
          url: item.title
            ? `https://www.dongchedi.com/search?keyword=${encodeURIComponent(item.title)}`
            : undefined,
        }))
      );
    },
  }),
  source({
    id: 'douban-movic',
    async fetch(signal) {
      const html = await fetchText('https://movie.douban.com/chart/', {
        signal,
        headers: { Referer: 'https://movie.douban.com/', 'User-Agent': DESKTOP_UA },
      });
      return withRanks(
        htmlBlocks(html, /<tr[^>]*class="[^"]*item[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi).map((block) => {
          const link = firstMatch(block, /<a[^>]+href="([^"]+)"/i);
          const score = firstMatch(
            block,
            /<span[^>]*class="[^"]*rating_nums[^"]*"[^>]*>([\s\S]*?)<\/span>/i
          );
          const title = firstMatch(block, /<a[^>]+title="([^"]+)"/i) ?? '';
          return {
            title,
            desc: firstMatch(block, /<p[^>]*class="[^"]*pl[^"]*"[^>]*>([\s\S]*?)<\/p>/i),
            hot: compactHot(
              firstMatch(block, /<span[^>]*class="[^"]*pl[^"]*"[^>]*>\(([\s\S]*?)\)<\/span>/i)
            ),
            timestamp: score ? `评分 ${score}` : undefined,
            url: link,
          };
        })
      );
    },
  }),
  source({
    id: 'hello-github',
    async fetch(signal) {
      const json = await fetchJson<HelloGithubResponse>(
        'https://api.hellogithub.com/v1/?sort_by=featured&page=1&rank_by=newest&tid=all',
        { signal, headers: { 'User-Agent': DESKTOP_UA } }
      );
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: [item.name, item.title].filter(Boolean).join(' - '),
          desc: item.summary,
          hot: compactHot(item.clicks_total),
          url: item.full_name ? `https://hellogithub.com/repository/${item.full_name}` : undefined,
        }))
      );
    },
  }),
  source({
    id: 'netease',
    async fetch(signal) {
      const json = await fetchJson<NeteaseResponse>('https://m.163.com/fe/api/hot/news/flow', {
        signal,
      });
      return withRanks(
        (json.data?.list ?? []).map((item) => ({
          title: item.title ?? '',
          desc: item._keyword,
          author: item.source,
          timestamp: normalizeTimestamp(item.publishTime ?? item.ptime),
          url:
            item.skipID || item.docid
              ? `https://www.163.com/dy/article/${item.skipID ?? item.docid}.html`
              : item.url,
        }))
      );
    },
  }),
  source({
    id: 'netease-music',
    async fetch(signal) {
      const json = await fetchJson<NeteaseMusicResponse>(
        'https://music.163.com/api/v6/playlist/detail?id=3778678&n=1000',
        {
          signal,
          headers: {
            authority: 'music.163.com',
            Referer: 'https://music.163.com/',
            'User-Agent': DESKTOP_UA,
          },
        }
      );
      return withRanks(
        (json.playlist?.tracks ?? json.result?.tracks ?? []).map((item) => ({
          title: item.name ?? '',
          author: (item.artists ?? item.ar ?? [])
            .map((artist) => artist.name)
            .filter(Boolean)
            .join('/'),
          hot: formatDuration(item.duration ?? item.dt),
          url: item.id ? `https://music.163.com/#/song?id=${item.id}` : undefined,
        }))
      );
    },
  }),
  source({
    id: 'qq',
    async fetch(signal) {
      const json = await fetchJson<QqNewsResponse>(
        'https://r.inews.qq.com/gw/event/hot_ranking_list',
        {
          signal,
          headers: { Referer: 'https://news.qq.com/', 'User-Agent': DESKTOP_UA },
        }
      );
      return withRanks(
        (json.idlist?.[0]?.newslist ?? []).slice(1).map((item) => ({
          title: item.title ?? '',
          desc: item.abstract,
          hot: compactHot(item.readCount ?? item.hotEvent?.hotScore),
          url: item.id ? `https://new.qq.com/rain/a/${item.id}` : undefined,
        }))
      );
    },
  }),
  source({
    id: 'quark',
    async fetch(signal) {
      const json = await fetchJson<QuarkResponse>(
        'https://iflow.quark.cn/iflow/api/v1/article/aggregation?aggregation_id=16665090098771297825&count=50&bottom_pos=0',
        { signal, headers: { Referer: 'https://iflow.quark.cn/', 'User-Agent': DESKTOP_UA } }
      );
      return withRanks(
        (json.data?.articles ?? []).map((item) => ({
          title: item.title ?? '',
          timestamp: normalizeTimestamp(item.publish_time),
          url: item.id ? `https://123.quark.cn/detail?item_id=${item.id}` : undefined,
        }))
      );
    },
  }),
  source({
    id: 'woshipm',
    async fetch(signal) {
      const json = await fetchJson<WoshipmResponse>(
        'https://www.woshipm.com/api2/app/article/popular/daily',
        {
          signal,
          headers: { Referer: 'https://www.woshipm.com/', 'User-Agent': DESKTOP_UA },
        }
      );
      return withRanks(
        (json.RESULT ?? []).map((item) => {
          const data = item.data ?? {};
          return {
            title: data.articleTitle ?? '',
            desc: data.articleSummary,
            hot: compactHot(item.scores),
            author: data.articleAuthor,
            url:
              data.id && data.type
                ? `https://www.woshipm.com/${data.type}/${data.id}.html`
                : undefined,
          };
        })
      );
    },
  }),
  source({
    id: 'xiaohongshu',
    async fetch(signal) {
      const json = await fetchJson<XiaohongshuResponse>(
        'https://edith.xiaohongshu.com/api/sns/v1/search/hot_list',
        {
          signal,
          headers: xiaohongshuHeaders(),
        }
      );
      return withRanks(
        (json.data?.items ?? []).map((item) => ({
          title: item.title ?? '',
          hot: compactHot(item.score),
          desc: item.word_type && item.word_type !== '无' ? item.word_type : undefined,
          url: item.title
            ? `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(item.title)}`
            : undefined,
        }))
      );
    },
  }),
] as const satisfies readonly HotListSource[];

function source(def: {
  id: ReferenceHotListSourceId;
  fetch(signal: AbortSignal): Promise<HotListItem[]>;
}): HotListSource {
  const id: CurrentHotListSourceIdT = def.id;
  return {
    id,
    label: hotListSourceLabel(id),
    fetch: (ctx) => def.fetch(ctx.signal),
  };
}

function formatDuration(value: unknown): string | undefined {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function xiaohongshuHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.7(0x18000733) NetType/WIFI Language/zh_CN',
    referer: 'https://app.xhs.cn/',
    shield:
      'XYAAAAAQAAAAEAAABTAAAAUzUWEe4xG1IYD9/c+qCLOlKGmTtFa+lG434Oe+FTRagxxoaz6rUWSZ3+juJYz8RZqct+oNMyZQxLEBaBEL+H3i0RhOBVGrauzVSARchIWFYwbwkV',
    'xy-common-params':
      'app_id=ECFAAF02&build=8070515&channel=AppStore&deviceId=C323D3A5-6A27-4CE6-AA0E-51C9D4C26A24&device_fingerprint=20230920120211bd7b71a80778509cf4211099ea911000010d2f20f6050264&device_fingerprint1=20230920120211bd7b71a80778509cf4211099ea911000010d2f20f6050264&device_model=phone&fid=1695182528-0-0-63b29d709954a1bb8c8733eb2fb58f29&gid=7dc4f3d168c355f1a886c54a898c6ef21fe7b9a847359afc77fc24ad&identifier_flag=0&lang=zh-Hans&launch_id=716882697&platform=iOS&project_id=ECFAAF&sid=session.1695189743787849952190&t=1695190591&teenager=0&tz=Asia/Shanghai&uis=light&version=8.7',
    'xy-direction': '22',
    'xy-platform-info':
      'platform=iOS&version=8.7&build=8070515&deviceId=C323D3A5-6A27-4CE6-AA0E-51C9D4C26A24&bundle=com.xingin.discover',
  };
}

interface DongchediNextData {
  props?: { pageProps?: { hotSearchList?: Array<{ title?: string; score?: string | number }> } };
}

interface HelloGithubResponse {
  data?: Array<{
    item_id?: string;
    full_name?: string;
    name?: string;
    title?: string;
    summary?: string;
    clicks_total?: number;
  }>;
}

interface NeteaseMusicResponse {
  playlist?: {
    tracks?: Array<NeteaseMusicTrack>;
  };
  result?: {
    tracks?: Array<NeteaseMusicTrack>;
  };
}

interface NeteaseMusicTrack {
  id?: string | number;
  name?: string;
  duration?: number;
  dt?: number;
  artists?: Array<{ name?: string }>;
  ar?: Array<{ name?: string }>;
}

interface QuarkResponse {
  data?: { articles?: Array<{ id?: string; title?: string; publish_time?: string }> };
}

interface WoshipmResponse {
  RESULT?: Array<{
    scores?: string | number;
    data?: {
      id?: string | number;
      type?: string;
      articleTitle?: string;
      articleSummary?: string;
      articleAuthor?: string;
    };
  }>;
}

interface XiaohongshuResponse {
  data?: {
    items?: Array<{
      title?: string;
      score?: string | number;
      word_type?: string;
    }>;
  };
}
