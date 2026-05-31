import crypto from 'node:crypto';
import {
  fetchArrayBuffer,
  fetchJson,
  fetchResponse,
  fetchText,
  DESKTOP_UA,
} from '../../../common/http/fetch';
import type { HotListItem, HotListSource } from '../hot-list.types';
import {
  firstMatch,
  htmlBlockMatches,
  htmlBlocks,
  jsonFromScript,
  parseRss,
  stripHtml,
} from '../html-utils';
import {
  absoluteUrl,
  compactHot,
  decodeGbk,
  normalizeTimestamp,
  withRanks,
} from '../hot-list.utils';
import { defineDirectSource } from '../source-factory';

type NewsNowDirectSourceId =
  | '36kr-quick'
  | 'bilibili-hot-search'
  | 'bilibili-ranking'
  | 'cankaoxiaoxi'
  | 'douban'
  | 'chongbuluo-hot'
  | 'chongbuluo-latest'
  | 'cls-depth'
  | 'cls-hot'
  | 'cls-telegraph'
  | 'fastbull'
  | 'fastbull-express'
  | 'fastbull-news'
  | 'freebuf'
  | 'gelonghui'
  | 'ifeng'
  | 'iqiyi-hot-ranklist'
  | 'jin10'
  | 'kaopu'
  | 'mktnews-flash'
  | 'nowcoder'
  | 'pcbeta-windows11'
  | 'solidot'
  | 'sputniknewscn'
  | 'steam'
  | 'tencent-hot'
  | 'v2ex-share'
  | 'wallstreetcn-hot'
  | 'wallstreetcn-news'
  | 'wallstreetcn-quick'
  | 'xueqiu-hotstock'
  | 'zaobao'
  | 'qqvideo-tv-hotsearch';

interface NewsNowDirectSourceDef {
  id: NewsNowDirectSourceId;
  label: string;
  fetch(signal: AbortSignal): Promise<HotListItem[]>;
}

export const NEWSNOW_DIRECT_SOURCES: readonly HotListSource[] = [
  source({
    id: '36kr-quick',
    label: '36氪',
    async fetch(signal) {
      const html = await fetchText('https://www.36kr.com/newsflashes', { signal });
      return withRanks(
        htmlBlocks(
          html,
          /<div[^>]*class="[^"]*newsflash-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
        ).map((block) => {
          const path = firstMatch(block, /<a[^>]*class="[^"]*item-title[^"]*"[^>]*href="([^"]+)"/i);
          return {
            title:
              firstMatch(block, /<a[^>]*class="[^"]*item-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ?? '',
            timestamp: firstMatch(
              block,
              /<span[^>]*class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/span>/i
            ),
            url: absoluteUrl('https://www.36kr.com', path),
          };
        })
      );
    },
  }),
  source({
    id: 'bilibili-hot-search',
    label: '哔哩哔哩',
    async fetch(signal) {
      const json = await fetchJson<BiliHotSearchResponse>(
        'https://s.search.bilibili.com/main/hotword?limit=30',
        {
          signal,
        }
      );
      return withRanks(
        (json.list ?? []).map((item) => ({
          title: item.show_name ?? item.keyword ?? '',
          hot: compactHot(item.heat_score ?? item.score),
          url: item.keyword
            ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(item.keyword)}`
            : undefined,
        }))
      );
    },
  }),
  source({
    id: 'bilibili-ranking',
    label: '哔哩哔哩',
    async fetch(signal) {
      const json = await fetchJson<BiliRankingResponse>(
        'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1',
        {
          signal,
          headers: {
            Referer: 'https://www.bilibili.com/v/popular/rank/all',
            'User-Agent': DESKTOP_UA,
          },
        }
      );
      return withRanks((json.data?.list ?? []).map(biliVideoItem));
    },
  }),
  source({
    id: 'cankaoxiaoxi',
    label: '参考消息',
    async fetch(signal) {
      const channels = ['zhongguo', 'guandian', 'gj'];
      const data = await Promise.all(
        channels.map((channel) =>
          fetchJson<CankaoxiaoxiResponse>(
            `https://china.cankaoxiaoxi.com/json/channel/${channel}/list.json`,
            {
              signal,
            }
          )
        )
      );
      return withRanks(
        data
          .flatMap((response) => response.list ?? [])
          .map((item) => ({
            title: item.data?.title ?? '',
            timestamp: normalizeTimestamp(item.data?.publishTime),
            url: item.data?.url,
          }))
          .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
      );
    },
  }),
  source({
    id: 'douban',
    label: '豆瓣',
    async fetch(signal) {
      const json = await fetchJson<DoubanHotMovieResponse>(
        'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie',
        {
          signal,
          headers: {
            Referer: 'https://movie.douban.com/',
            Accept: 'application/json, text/plain, */*',
          },
        }
      );
      return withRanks(
        (json.items ?? []).map((item) => ({
          title: item.title ?? '',
          desc: item.card_subtitle,
          hot: compactHot(item.rating?.value),
          url: item.id ? `https://movie.douban.com/subject/${item.id}` : undefined,
        }))
      );
    },
  }),
  source({
    id: 'chongbuluo-hot',
    label: '虫部落',
    async fetch(signal) {
      const base = 'https://www.chongbuluo.com/';
      const html = await fetchText(`${base}forum.php?mod=guide&view=hot`, { signal });
      return withRanks(
        htmlBlockMatches(html, /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi).map((match) => {
          const block = match[1] ?? '';
          const path = firstMatch(block, /<a[^>]*class="[^"]*xst[^"]*"[^>]*href="([^"]+)"/i);
          return {
            title: firstMatch(block, /<a[^>]*class="[^"]*xst[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ?? '',
            url: absoluteUrl(base, path),
          };
        })
      );
    },
  }),
  rssSource(
    'chongbuluo-latest',
    '虫部落',
    'https://www.chongbuluo.com/forum.php?mod=rss&view=newthread'
  ),
  source({
    id: 'cls-depth',
    label: '财联社',
    async fetch(signal) {
      const json = await fetchJson<ClsDepthResponse>(
        `https://www.cls.cn/v3/depth/home/assembled/1000?${clsSearchParams()}`,
        { signal }
      );
      return withRanks(
        (json.data?.depth_list ?? []).sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)).map(clsItem)
      );
    },
  }),
  source({
    id: 'cls-hot',
    label: '财联社',
    async fetch(signal) {
      const json = await fetchJson<ClsHotResponse>(
        `https://www.cls.cn/v2/article/hot/list?${clsSearchParams()}`,
        {
          signal,
        }
      );
      return withRanks((json.data ?? []).map(clsItem));
    },
  }),
  source({
    id: 'cls-telegraph',
    label: '财联社',
    async fetch(signal) {
      const json = await fetchJson<ClsTelegraphResponse>(
        `https://www.cls.cn/v1/roll/get_roll_list?${clsRollSearchParams()}`,
        {
          signal,
          headers: {
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.cls.cn/telegraph',
            'User-Agent': DESKTOP_UA,
          },
        }
      );
      return withRanks((json.data?.roll_data ?? []).filter((item) => !item.is_ad).map(clsItem));
    },
  }),
  fastbullSource('fastbull'),
  fastbullSource('fastbull-express'),
  source({
    id: 'fastbull-news',
    label: '法布财经',
    async fetch(signal) {
      const html = await fetchText('https://www.fastbull.com/cn/news', { signal });
      return withRanks(
        htmlBlockMatches(
          html,
          /<a[^>]*href="([^"]+)"[^>]*class="[^"]*trending_type[^"]*"[^>]*>[\s\S]*?<h4[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h4>[\s\S]*?<span[^>]*class="[^"]*new_time[^"]*"[^>]*data-date="([^"]+)"/gi
        ).map((match) => {
          return {
            title: stripHtml(match[2] ?? ''),
            timestamp: normalizeTimestamp(Number(match[3])),
            url: absoluteUrl('https://www.fastbull.com', match[1]),
          };
        })
      );
    },
  }),
  source({
    id: 'freebuf',
    label: 'FreeBuf',
    async fetch(signal) {
      const html = await fetchText('https://www.freebuf.com/', {
        signal,
        headers: { Referer: 'https://www.freebuf.com/', 'User-Agent': DESKTOP_UA },
      });
      return withRanks(parseFreebufNuxtPosts(html));
    },
  }),
  source({
    id: 'gelonghui',
    label: '格隆汇',
    async fetch(signal) {
      const html = await fetchText('https://www.gelonghui.com/news/', { signal });
      return withRanks(
        htmlBlockMatches(
          html,
          /<section[^>]*class="article-content"[\s\S]*?<section[^>]*class="detail-right"[\s\S]*?<a[^>]*href="([^"]+)"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>[\s\S]*?<p[^>]*class="time"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*>\|<\/span>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi
        ).map((match) => ({
          title: stripHtml(match[2] ?? ''),
          desc: stripHtml(match[3] ?? ''),
          author: stripHtml(match[4] ?? ''),
          timestamp: stripHtml(match[5] ?? ''),
          url: absoluteUrl('https://www.gelonghui.com', match[1]),
        }))
      );
    },
  }),
  source({
    id: 'ifeng',
    label: '凤凰网',
    async fetch(signal) {
      const html = await fetchText('https://www.ifeng.com/', { signal });
      const json = jsonFromScript<IfengAllData>(html, /var\s+allData\s*=\s*(\{[\s\S]*?\});/);
      return withRanks(
        (json?.hotNews1 ?? []).map((item) => ({
          title: item.title ?? '',
          timestamp: normalizeTimestamp(item.newsTime),
          url: item.url,
        }))
      );
    },
  }),
  source({
    id: 'iqiyi-hot-ranklist',
    label: '爱奇艺',
    async fetch(signal) {
      const json = await fetchJson<IqiyiResponse>(
        'https://mesh.if.iqiyi.com/portal/lw/v7/channel/card/videoTab?channelName=recommend&data_source=v7_rec_sec_hot_rank_list&tempId=85&count=30&block_id=hot_ranklist&device=14a4b5ba98e790dce6dc07482447cf48&from=webapp',
        { signal, headers: { Referer: 'https://www.iqiyi.com' } }
      );
      return withRanks(
        (json.items?.[0]?.video?.[0]?.data ?? []).map((item) => ({
          title: item.title ?? item.display_name ?? '',
          desc: item.description ?? item.desc,
          author: item.tag,
          timestamp: normalizeTimestamp(item.showDate),
          url: item.page_url,
        }))
      );
    },
  }),
  source({
    id: 'jin10',
    label: '金十数据',
    async fetch(signal) {
      const text = await fetchText(`https://www.jin10.com/flash_newest.js?t=${Date.now()}`, {
        signal,
      });
      const raw = text.replace(/^var\s+newest\s*=\s*/, '').replace(/;*\s*$/, '');
      const data = JSON.parse(raw) as Jin10Item[];
      return withRanks(
        data
          .filter((item) => (item.data?.title || item.data?.content) && !item.channel?.includes(5))
          .map((item) => {
            const text = stripHtml(item.data?.title || item.data?.content || '');
            const match = text.match(/^【([^】]*)】(.*)$/);
            return {
              title: match?.[1] ?? text,
              desc: match?.[2],
              hot: item.important ? '重要' : undefined,
              timestamp: normalizeTimestamp(item.time),
              url: item.id ? `https://flash.jin10.com/detail/${item.id}` : undefined,
            };
          })
      );
    },
  }),
  source({
    id: 'kaopu',
    label: '靠谱新闻',
    async fetch(signal) {
      const json = await fetchJson<KaopuItem[]>(
        'https://kaopustorage.blob.core.windows.net/news-prod/news_list_hans_0.json',
        { signal }
      );
      return withRanks(
        json
          .filter((item) => !['财新', '公视'].includes(item.publisher ?? ''))
          .map((item) => ({
            title: item.title ?? '',
            desc: item.description,
            author: item.publisher,
            timestamp: normalizeTimestamp(item.pub_date),
            url: item.link,
          }))
      );
    },
  }),
  source({
    id: 'mktnews-flash',
    label: 'MKTNews',
    async fetch(signal) {
      const json = await fetchJson<MktNewsResponse>(
        'https://api.mktnews.net/api/flash?type=0&limit=50',
        {
          signal,
        }
      );
      return withRanks(
        (json.data ?? [])
          .sort((a, b) => new Date(b.time ?? 0).getTime() - new Date(a.time ?? 0).getTime())
          .map((item) => ({
            title:
              item.data?.title ||
              item.data?.content?.match(/^【([^】]*)】/)?.[1] ||
              item.data?.content ||
              '',
            desc: item.data?.content,
            hot: item.important === 1 ? 'Important' : undefined,
            timestamp: normalizeTimestamp(item.time),
            url: item.id ? `https://mktnews.net/flashDetail.html?id=${item.id}` : undefined,
          }))
      );
    },
  }),
  source({
    id: 'nowcoder',
    label: '牛客',
    async fetch(signal) {
      const json = await fetchJson<NowcoderResponse>(
        `https://gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_=${Date.now()}&t=`,
        { signal }
      );
      return withRanks(
        (json.data?.result ?? []).map((item) => ({
          title: item.title ?? '',
          url:
            item.type === 74 && item.uuid
              ? `https://www.nowcoder.com/feed/main/detail/${item.uuid}`
              : item.id
                ? `https://www.nowcoder.com/discuss/${item.id}`
                : undefined,
        }))
      );
    },
  }),
  rssSource(
    'pcbeta-windows11',
    '远景论坛',
    'https://bbs.pcbeta.com/forum.php?mod=rss&fid=563&auth=0'
  ),
  source({
    id: 'solidot',
    label: 'Solidot',
    async fetch(signal) {
      const html = await fetchText('https://www.solidot.org', { signal });
      return withRanks(
        htmlBlocks(
          html,
          /<div[^>]*class="[^"]*block_m[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
        ).map((block) => {
          const path = firstMatch(
            block,
            /<div[^>]*class="[^"]*bg_htit[^"]*"[^>]*>[\s\S]*<a[^>]+href="([^"]+)"/i
          );
          return {
            title:
              firstMatch(
                block,
                /<div[^>]*class="[^"]*bg_htit[^"]*"[^>]*>[\s\S]*<a[^>]*>([\s\S]*?)<\/a>/i
              ) ?? '',
            timestamp: firstMatch(
              block,
              /<div[^>]*class="[^"]*talk_time[^"]*"[^>]*>[\s\S]*?发表于([\s\S]*?分)/i
            ),
            url: absoluteUrl('https://www.solidot.org', path),
          };
        })
      );
    },
  }),
  source({
    id: 'sputniknewscn',
    label: '卫星通讯社',
    async fetch(signal) {
      const html = await fetchText('https://sputniknews.cn/services/widget/lenta/', { signal });
      return withRanks(
        htmlBlocks(html, /<div[^>]*class="[^"]*lenta__item[^"]*"[^>]*>([\s\S]*?)<\/div>/gi).map(
          (block) => {
            const path = firstMatch(block, /<a[^>]+href="([^"]+)"/i);
            return {
              title:
                firstMatch(
                  block,
                  /<span[^>]*class="[^"]*lenta__item-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i
                ) ?? '',
              timestamp: normalizeTimestamp(Number(firstMatch(block, /data-unixtime="([^"]+)"/i))),
              url: absoluteUrl('https://sputniknews.cn', path),
            };
          }
        )
      );
    },
  }),
  source({
    id: 'steam',
    label: 'Steam',
    async fetch(signal) {
      const html = await fetchText('https://store.steampowered.com/stats/stats/', { signal });
      return withRanks(
        htmlBlocks(html, /<tr[^>]*class="[^"]*player_count_row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi).map(
          (block) => ({
            title:
              firstMatch(block, /<a[^>]*class="[^"]*gameLink[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ?? '',
            hot: firstMatch(
              block,
              /<span[^>]*class="[^"]*currentServers[^"]*"[^>]*>([\s\S]*?)<\/span>/i
            ),
            url: firstMatch(block, /<a[^>]*class="[^"]*gameLink[^"]*"[^>]*href="([^"]+)"/i),
          })
        )
      );
    },
  }),
  source({
    id: 'tencent-hot',
    label: '腾讯新闻',
    async fetch(signal) {
      const json = await fetchJson<TencentHotResponse>(
        'https://i.news.qq.com/web_backend/v2/getTagInfo?tagId=aEWqxLtdgmQ%3D',
        { signal, headers: { Referer: 'https://news.qq.com/' } }
      );
      return withRanks(
        (json.data?.tabs?.[0]?.articleList ?? []).map((item) => ({
          title: item.title ?? '',
          desc: item.desc,
          url: item.link_info?.url,
        }))
      );
    },
  }),
  source({
    id: 'v2ex-share',
    label: 'V2EX',
    async fetch(signal) {
      const feeds = await Promise.all(
        ['create', 'ideas', 'programmer', 'share'].map((name) =>
          fetchJson<V2exFeedResponse>(`https://www.v2ex.com/feed/${name}.json`, { signal })
        )
      );
      return withRanks(
        feeds
          .flatMap((feed) => feed.items ?? [])
          .map((item) => ({
            title: item.title ?? '',
            desc: item.content_html,
            timestamp: normalizeTimestamp(item.date_modified ?? item.date_published),
            url: item.url,
          }))
          .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))
      );
    },
  }),
  wallstreetcnSource('wallstreetcn-quick'),
  wallstreetcnSource('wallstreetcn-news'),
  wallstreetcnSource('wallstreetcn-hot'),
  source({
    id: 'xueqiu-hotstock',
    label: '雪球',
    async fetch(signal) {
      const cookie = await xueqiuCookie(signal).catch(() => '');
      const json = await fetchJson<XueqiuHotStockResponse>(
        'https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=30&_type=10&type=10',
        { signal, headers: cookie ? { cookie } : undefined }
      );
      return withRanks(
        (json.data?.items ?? [])
          .filter((item) => !item.ad)
          .map((item) => ({
            title: item.name ?? '',
            hot:
              item.percent == null ? undefined : `${item.percent}% ${item.exchange ?? ''}`.trim(),
            url: item.code ? `https://xueqiu.com/s/${item.code}` : undefined,
          }))
      );
    },
  }),
  source({
    id: 'zaobao',
    label: '联合早报',
    async fetch(signal) {
      const html = decodeGbk(
        await fetchArrayBuffer('https://www.zaochenbao.com/realtime/', { signal })
      );
      return withRanks(
        htmlBlockMatches(
          html,
          /<a[^>]*href="([^"]+)"[^>]*class="[^"]*item[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
        ).map((match) => {
          const block = match[2] ?? '';
          return {
            title:
              firstMatch(block, /<div[^>]*class="[^"]*eps[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ?? '',
            timestamp: firstMatch(
              block,
              /<div[^>]*class="[^"]*pdt10[^"]*"[^>]*>([\s\S]*?)<\/div>/i
            )?.replace(/-\s/g, ' '),
            url: absoluteUrl('https://www.zaochenbao.com', match[1]),
          };
        })
      );
    },
  }),
  source({
    id: 'qqvideo-tv-hotsearch',
    label: '腾讯视频',
    async fetch(signal) {
      const json = await fetchJson<QqVideoResponse>(
        'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getCard?video_appid=3000010&vversion_platform=2',
        {
          signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Referer: 'https://v.qq.com/' },
          body: qqVideoBody(),
        }
      );
      return withRanks(
        (json.data?.card?.children_list?.list?.cards ?? []).map((item) => ({
          title: item.params?.title ?? '',
          desc: item.params?.sub_title,
          timestamp: normalizeTimestamp(item.params?.publish_date),
          url: item.id ? `https://v.qq.com/x/cover/${item.id}.html` : undefined,
        }))
      );
    },
  }),
];

function source(def: NewsNowDirectSourceDef): HotListSource {
  return defineDirectSource(def);
}

function rssSource(id: NewsNowDirectSourceId, label: string, url: string): HotListSource {
  return source({
    id,
    label,
    async fetch(signal) {
      const xml = await fetchText(url, { signal });
      return withRanks(
        parseRss(xml).map((item) => ({
          title: item.title ?? '',
          desc: item.content ?? item.description,
          author: item.author,
          timestamp: normalizeTimestamp(item.pubDate),
          url: item.link,
        }))
      );
    },
  });
}

function fastbullSource(id: 'fastbull' | 'fastbull-express'): HotListSource {
  return source({
    id,
    label: '法布财经',
    async fetch(signal) {
      const html = await fetchText('https://www.fastbull.com/cn/express-news', { signal });
      return withRanks(
        htmlBlockMatches(
          html,
          /<div[^>]*class="[^"]*news-list[^"]*"[^>]*data-date="([^"]+)"[\s\S]*?<div[^>]*class="[^"]*shear_box box_show[^"]*"[^>]*data-title="([^"]+)"[^>]*data-href="([^"]+)"/gi
        ).map((match) => {
          const rawTitle = stripHtml(match[2] ?? '');
          return {
            title: rawTitle.match(/【(.+)】/)?.[1] ?? rawTitle,
            timestamp: normalizeTimestamp(Number(match[1])),
            url: absoluteUrl('https://www.fastbull.com', match[3]),
          };
        })
      );
    },
  });
}

function wallstreetcnSource(
  id: 'wallstreetcn-quick' | 'wallstreetcn-news' | 'wallstreetcn-hot'
): HotListSource {
  return source({
    id,
    label: '华尔街见闻',
    async fetch(signal) {
      if (id === 'wallstreetcn-hot') {
        const json = await fetchJson<WallstreetHotResponse>(
          'https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all',
          { signal }
        );
        return withRanks((json.data?.day_items ?? []).map(wallstreetItem));
      }
      if (id === 'wallstreetcn-news') {
        const json = await fetchJson<WallstreetNewsResponse>(
          'https://api-one.wallstcn.com/apiv1/content/information-flow?channel=global-channel&accept=article&limit=30',
          { signal }
        );
        return withRanks(
          (json.data?.items ?? [])
            .filter(
              (item) =>
                item.resource_type !== 'theme' &&
                item.resource_type !== 'ad' &&
                item.resource?.type !== 'live'
            )
            .map((item) => wallstreetItem(item.resource))
        );
      }
      const json = await fetchJson<WallstreetLiveResponse>(
        'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30',
        { signal }
      );
      return withRanks((json.data?.items ?? []).map(wallstreetItem));
    },
  });
}

function biliVideoItem(video: BiliVideo): Omit<HotListItem, 'rank'> {
  return {
    title: video.title ?? '',
    desc: video.desc,
    author: video.owner?.name,
    hot: compactHot(video.stat?.view, '播放'),
    timestamp: normalizeTimestamp(video.pubdate),
    url: video.bvid ? `https://www.bilibili.com/video/${video.bvid}` : undefined,
  };
}

function clsItem(item: ClsItem): Omit<HotListItem, 'rank'> {
  return {
    title: item.title || item.brief || '',
    timestamp: normalizeTimestamp(item.ctime),
    url: item.id ? `https://www.cls.cn/detail/${item.id}` : item.shareurl,
  };
}

function wallstreetItem(item?: WallstreetItem): Omit<HotListItem, 'rank'> {
  return {
    title: item?.title || item?.content_short || item?.content_text || '',
    timestamp: normalizeTimestamp(item?.display_time),
    url: item?.uri,
  };
}

function clsSearchParams(): string {
  const params = new URLSearchParams({ appName: 'CailianpressWeb', os: 'web', sv: '7.7.5' });
  params.sort();
  const sha1 = crypto.createHash('sha1').update(params.toString()).digest('hex');
  params.append('sign', crypto.createHash('md5').update(sha1).digest('hex'));
  return params.toString();
}

function clsRollSearchParams(): string {
  const params: ClsSignParams = {
    app: 'CailianpressWeb',
    last_time: Math.floor(Date.now() / 1000),
    os: 'web',
    refresh_type: 1,
    rn: 30,
    sv: '8.7.9',
  };
  const query = new URLSearchParams();
  for (const key of Object.keys(params).sort(compareClsParamKey)) {
    query.append(key, String(params[key]));
  }
  query.append('sign', clsSign(params));
  return query.toString();
}

type ClsSignValue =
  | string
  | number
  | boolean
  | null
  | readonly ClsSignValue[]
  | { readonly [key: string]: ClsSignValue };
type ClsSignParams = Record<string, ClsSignValue>;

function clsSign(params: ClsSignParams): string {
  const raw = Object.keys(params)
    .sort(compareClsParamKey)
    .map((key) => clsSerializeParam(key, params[key]))
    .filter(Boolean)
    .join('&');
  const sha1 = crypto.createHash('sha1').update(raw).digest('hex');
  return crypto.createHash('md5').update(sha1).digest('hex');
}

function clsSerializeParam(key: string, value: ClsSignValue): string {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${key}=${String(value)}`;
  }
  if (Array.isArray(value)) {
    return value.length
      ? value
          .map((item, index) => clsSerializeParam(`${key}[${index}]`, item))
          .filter(Boolean)
          .join('&')
      : `${key}[]`;
  }
  const objectValue = value as { readonly [key: string]: ClsSignValue };
  return Object.keys(objectValue)
    .sort(compareClsParamKey)
    .map((childKey) => clsSerializeParam(`${key}[${childKey}]`, objectValue[childKey]))
    .filter(Boolean)
    .join('&');
}

function compareClsParamKey(a: string, b: string): number {
  const upperA = a.toUpperCase();
  const upperB = b.toUpperCase();
  return upperA > upperB ? 1 : upperA === upperB ? 0 : -1;
}

function parseFreebufNuxtPosts(html: string): Array<Omit<HotListItem, 'rank'>> {
  const posts = Array.from(
    html.matchAll(/(?:ID|id):"?(\d+)"?,post_title:"([^"]+)"[\s\S]{0,500}?url:"([^"]+)"/g),
    (match) => ({
      title: stripHtml(match[2] ?? ''),
      url: absoluteUrl('https://www.freebuf.com', (match[3] ?? '').replace(/\\u002F/g, '/')),
    })
  );
  return posts;
}

async function xueqiuCookie(signal: AbortSignal): Promise<string> {
  const resp = await fetchResponse('https://xueqiu.com/hq', {
    signal,
    timeoutMs: 5000,
    headers: { Referer: 'https://xueqiu.com/' },
  });
  const headers = resp.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.().join('; ') ?? headers.get('set-cookie') ?? '';
}

function qqVideoBody(): unknown {
  return {
    page_params: {
      rank_channel_id: '100113',
      rank_name: 'HotSearch',
      rank_page_size: '30',
      tab_mvl_sub_mod_id: '792ac_19e77Sub_1b2',
      tab_name: '热搜榜',
      tab_type: 'hot_rank',
      tab_vl_data_src: 'f5200deb4596bbf3',
      page_id: 'scms_shake',
      page_type: 'scms_shake',
      source_key: '',
      tag_id: '',
      tag_type: '',
      new_mark_label_enabled: '1',
    },
    page_context: { page_index: '1' },
    flip_info: {
      page_strategy_id: '',
      page_module_id: '792ac_19e77',
      module_strategy_id: {},
      sub_module_id: '20251106065177',
      flip_params: {
        folding_screen_show_num: '',
        is_mvl: '1',
        mvl_strategy_info:
          '{"default_strategy_id":"06755800b45b49238582a6fa1ad0f5c5","default_version":"3836","hit_page_uuid":"b5080d97dc694a5fb50eb9e7c99326ac","hit_tab_info":null,"gray_status_info":null,"bypass_to_un_exp_id":""}',
        mvl_sub_mod_id: '20251106065177',
        pad_post_show_num: '',
        pad_pro_post_show_num: '',
        pad_pro_small_hor_pic_display_num: '',
        pad_small_hor_pic_display_num: '',
        page_id: 'scms_shake',
        page_num: '0',
        page_type: 'scms_shake',
        post_show_num: '',
        shake_size: '',
        small_hor_pic_display_num: '',
        source_key: '100113',
        un_policy_id: '06755800b45b49238582a6fa1ad0f5c5',
        un_strategy_id: '06755800b45b49238582a6fa1ad0f5c5',
      },
      relace_children_key: [],
    },
  };
}

interface BiliHotSearchResponse {
  list?: Array<{ keyword?: string; show_name?: string; score?: number; heat_score?: number }>;
}

interface BiliRankingResponse {
  data?: { list?: BiliVideo[] };
}

interface BiliVideo {
  title?: string;
  desc?: string;
  bvid?: string;
  pubdate?: number;
  owner?: { name?: string };
  stat?: { view?: number };
}

interface CankaoxiaoxiResponse {
  list?: Array<{ data?: { title?: string; url?: string; publishTime?: string } }>;
}

interface DoubanHotMovieResponse {
  items?: Array<{
    id?: string;
    title?: string;
    card_subtitle?: string;
    rating?: { value?: number };
  }>;
}

interface ClsItem {
  id?: number;
  title?: string;
  brief?: string;
  shareurl?: string;
  ctime?: number;
  is_ad?: number;
}

interface ClsDepthResponse {
  data?: { depth_list?: ClsItem[] };
}

interface ClsHotResponse {
  data?: ClsItem[];
}

interface ClsTelegraphResponse {
  data?: { roll_data?: ClsItem[] };
}

interface IfengAllData {
  hotNews1?: Array<{ title?: string; url?: string; newsTime?: string }>;
}

interface IqiyiResponse {
  items?: Array<{
    video?: Array<{
      data?: Array<{
        title?: string;
        display_name?: string;
        description?: string;
        desc?: string;
        tag?: string;
        showDate?: string;
        page_url?: string;
      }>;
    }>;
  }>;
}

interface Jin10Item {
  id?: string;
  time?: string;
  important?: number;
  channel?: number[];
  data?: { title?: string; content?: string };
}

interface KaopuItem {
  title?: string;
  description?: string;
  publisher?: string;
  pub_date?: string;
  link?: string;
}

interface MktNewsResponse {
  data?: Array<{
    id?: string;
    time?: string;
    important?: number;
    data?: { title?: string; content?: string };
  }>;
}

interface NowcoderResponse {
  data?: { result?: Array<{ id?: string; title?: string; type?: number; uuid?: string }> };
}

interface TencentHotResponse {
  data?: {
    tabs?: Array<{
      articleList?: Array<{ title?: string; desc?: string; link_info?: { url?: string } }>;
    }>;
  };
}

interface V2exFeedResponse {
  items?: Array<{
    title?: string;
    content_html?: string;
    date_modified?: string;
    date_published?: string;
    url?: string;
  }>;
}

interface WallstreetItem {
  id?: number;
  title?: string;
  content_text?: string;
  content_short?: string;
  display_time?: number;
  type?: string;
  uri?: string;
}

interface WallstreetLiveResponse {
  data?: { items?: WallstreetItem[] };
}

interface WallstreetNewsResponse {
  data?: { items?: Array<{ resource_type?: string; resource?: WallstreetItem }> };
}

interface WallstreetHotResponse {
  data?: { day_items?: WallstreetItem[] };
}

interface XueqiuHotStockResponse {
  data?: {
    items?: Array<{
      code?: string;
      name?: string;
      percent?: number;
      exchange?: string;
      ad?: number;
    }>;
  };
}

interface QqVideoResponse {
  data?: {
    card?: {
      children_list?: {
        list?: {
          cards?: Array<{
            id?: string;
            params?: { title?: string; sub_title?: string; publish_date?: string };
          }>;
        };
      };
    };
  };
}
