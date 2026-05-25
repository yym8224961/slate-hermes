import crypto from 'node:crypto';
import { fetchArrayBuffer, fetchJson, fetchText, DESKTOP_UA } from '../fetch';
import type { HotListItem, HotListSource } from '../hot-list.types';
import { firstMatch, htmlBlockMatches, htmlBlocks, parseRss, stripHtml } from '../html';
import {
  absoluteUrl,
  cleanText,
  compactHot,
  normalizeTimestamp,
  withRanks,
  type NeteaseResponse,
  type QqNewsResponse,
} from '../text';

type DirectSourceId =
  | '51cto'
  | '52pojie'
  | 'acfun'
  | 'csdn'
  | 'coolapk'
  | 'dgtle'
  | 'douban-group'
  | 'douban-movie'
  | 'gameres'
  | 'geekpark'
  | 'guokr'
  | 'hackernews'
  | 'huxiu'
  | 'ifanr'
  | 'ithome-xijiayi'
  | 'jianshu'
  | 'linuxdo'
  | 'miyoushe'
  | 'netease-news'
  | 'newsmth'
  | 'ngabbs'
  | 'nodeseek'
  | 'nytimes'
  | 'producthunt'
  | 'qq-news'
  | 'sina'
  | 'sina-news'
  | 'weread'
  | 'yystv'
  | 'zhihu-daily';

interface DirectSourceDef {
  id: DirectSourceId;
  label: string;
  fetch(signal: AbortSignal): Promise<HotListItem[]>;
}

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; Mi 10) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const COOLAPK_UA =
  'Dalvik/2.1.0 (Linux; U; Android 10; Redmi K30 5G MIUI/V12.0.3.0.QGICMXM) ' +
  '(#Build; Redmi; Redmi K30 5G; QKQ1.191222.002 test-keys; 10) +CoolMarket/11.0-2101202';

export const DAILY_HOT_DIRECT_SOURCES: readonly HotListSource[] = [
  directSource({
    id: '51cto',
    label: '51CTO',
    async fetch(signal) {
      const params: Record<string, string | number> = {
        page: 1,
        page_size: 50,
        limit_time: 0,
        name_en: '',
      };
      const tokenJson = await fetchJson<CtoTokenResponse>(
        'https://api-media.51cto.com/api/token-get',
        {
          signal,
        }
      );
      const token = tokenJson.data?.data?.token ?? '';
      const timestamp = Date.now();
      const url = new URL('https://api-media.51cto.com/index/index/recommend');
      for (const [key, value] of Object.entries({
        ...params,
        timestamp,
        token,
        sign: sign51cto('index/index/recommend', params, timestamp, token),
      })) {
        url.searchParams.set(key, String(value));
      }
      const json = await fetchJson<CtoResponse>(url.toString(), { signal });
      return withRanks(
        (json.data?.data?.list ?? []).map((item) => ({
          title: item.title ?? '',
          desc: item.abstract,
          author: item.source_name,
          timestamp: normalizeTimestamp(item.pubdate),
          url: item.url,
        }))
      );
    },
  }),
  rssSource('52pojie', '吾爱破解', 'https://www.52pojie.cn/forum.php?mod=guide&view=digest&rss=1', {
    encoding: 'gbk',
    headers: { 'User-Agent': MOBILE_UA },
  }),
  directSource({
    id: 'acfun',
    label: 'AcFun',
    async fetch(signal) {
      const json = await fetchJson<AcfunResponse>(
        'https://www.acfun.cn/rest/pc-direct/rank/channel?channelId=&rankLimit=30&rankPeriod=DAY',
        {
          signal,
          headers: { Referer: 'https://www.acfun.cn/rank/list/?cid=-1&pcid=-1&range=DAY' },
        }
      );
      return withRanks(
        (json.rankList ?? []).map((item) => ({
          title: item.contentTitle ?? '',
          desc: item.contentDesc,
          author: item.userName,
          hot: compactHot(item.likeCount, '赞'),
          timestamp: normalizeTimestamp(item.contributeTime),
          url: item.dougaId ? `https://www.acfun.cn/v/ac${item.dougaId}` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'csdn',
    label: 'CSDN',
    async fetch(signal) {
      const json = await fetchJson<CsdnResponse>(
        'https://blog.csdn.net/phoenix/web/blog/hot-rank?page=0&pageSize=30',
        { signal }
      );
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: item.articleTitle ?? '',
          author: item.nickName,
          hot: compactHot(item.hotRankScore, '热度'),
          timestamp: normalizeTimestamp(item.period),
          url: item.articleDetailUrl,
        }))
      );
    },
  }),
  directSource({
    id: 'coolapk',
    label: '酷安',
    async fetch(signal) {
      const json = await fetchJson<CoolapkResponse>(
        'https://api.coolapk.com/v6/page/dataList?url=/feed/statList?cacheExpires=300&statType=day&sortField=detailnum&title=今日热门&subTitle=&page=1',
        { signal, headers: coolapkHeaders() }
      );
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: item.message ?? '',
          desc: item.ttitle,
          author: item.username,
          url: item.shareUrl,
        }))
      );
    },
  }),
  directSource({
    id: 'dgtle',
    label: '数字尾巴',
    async fetch(signal) {
      const json = await fetchJson<DgtleResponse>('https://opser.api.dgtle.com/v2/news/index', {
        signal,
      });
      return withRanks(
        (json.items ?? []).map((item) => ({
          title: item.title || item.content || '',
          desc: item.content,
          author: item.from,
          hot: compactHot(item.membernum),
          timestamp: normalizeTimestamp(item.created_at),
          url: item.id ? `https://www.dgtle.com/news-${item.id}-${item.type}.html` : undefined,
        }))
      );
    },
  }),
  htmlListSource({
    id: 'douban-group',
    label: '豆瓣讨论小组',
    url: 'https://www.douban.com/group/explore',
    blockPattern: /<div[^>]*class="[^"]*channel-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
    map(block) {
      const link = firstMatch(block, /<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i);
      const id = link?.match(/topic\/(\d+)/)?.[1];
      return {
        title: firstMatch(block, /<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) ?? '',
        desc: firstMatch(
          block,
          /<div[^>]*class="[^"]*block[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
        ),
        timestamp: firstMatch(
          block,
          /<span[^>]*class="[^"]*pubtime[^"]*"[^>]*>([\s\S]*?)<\/span>/i
        ),
        url: link ?? (id ? `https://www.douban.com/group/topic/${id}` : undefined),
      };
    },
  }),
  htmlListSource({
    id: 'douban-movie',
    label: '豆瓣电影',
    url: 'https://movie.douban.com/chart/',
    headers: { 'User-Agent': MOBILE_UA },
    blockPattern: /<tr[^>]*class="[^"]*item[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
    map(block) {
      const link = firstMatch(block, /<a[^>]+href="([^"]+)"/i);
      const score = firstMatch(
        block,
        /<span[^>]*class="[^"]*rating_nums[^"]*"[^>]*>([\s\S]*?)<\/span>/i
      );
      const title = firstMatch(block, /<a[^>]+title="([^"]+)"/i) ?? '';
      return {
        title: score ? `【${score}】${title}` : title,
        desc: firstMatch(block, /<p[^>]*class="[^"]*pl[^"]*"[^>]*>([\s\S]*?)<\/p>/i),
        hot: compactHot(
          firstMatch(block, /<span[^>]*class="[^"]*pl[^"]*"[^>]*>\(([\s\S]*?)\)<\/span>/i)
        ),
        url: link,
      };
    },
  }),
  htmlListSource({
    id: 'gameres',
    label: 'GameRes 游资网',
    url: 'https://www.gameres.com',
    blockPattern: /<article[^>]*class="[^"]*feed-item[^"]*"[^>]*>([\s\S]*?)<\/article>/gi,
    map(block) {
      const link = firstMatch(
        block,
        /<a[^>]*class="[^"]*feed-item-title-a[^"]*"[^>]*href="([^"]+)"/i
      );
      return {
        title:
          firstMatch(block, /<a[^>]*class="[^"]*feed-item-title-a[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ??
          '',
        desc: firstMatch(
          block,
          /<div[^>]*class="[^"]*feed-item-right[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
        ),
        timestamp: firstMatch(
          block,
          /<span[^>]*class="[^"]*mark-info[^"]*"[^>]*>([\s\S]*?)<\/span>/i
        ),
        url: absoluteUrl('https://www.gameres.com', link),
      };
    },
  }),
  directSource({
    id: 'geekpark',
    label: '极客公园',
    async fetch(signal) {
      const json = await fetchJson<GeekparkResponse>('https://mainssl.geekpark.net/api/v2', {
        signal,
      });
      return withRanks(
        (json.homepage_posts ?? []).map(({ post }) => ({
          title: post?.title ?? '',
          desc: post?.abstract,
          author: post?.authors?.[0]?.nickname,
          hot: compactHot(post?.views),
          timestamp: normalizeTimestamp(post?.published_timestamp),
          url: post?.id ? `https://www.geekpark.net/news/${post.id}` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'guokr',
    label: '果壳',
    async fetch(signal) {
      const json = await fetchJson<GuokrItem[]>(
        'https://www.guokr.com/beta/proxy/science_api/articles?limit=30',
        { signal }
      );
      return withRanks(
        json.map((item) => ({
          title: item.title ?? '',
          desc: item.summary,
          author: item.author?.nickname,
          timestamp: normalizeTimestamp(item.date_modified),
          url: item.id ? `https://www.guokr.com/article/${item.id}` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'hackernews',
    label: 'Hacker News',
    async fetch(signal) {
      const html = await fetchText('https://news.ycombinator.com', { signal });
      const scores = new Map(
        Array.from(html.matchAll(/id="score_(\d+)"[^>]*>(\d+)\s+points?/gi), (match) => [
          match[1] ?? '',
          Number(match[2]),
        ])
      );
      return withRanks(
        htmlBlockMatches(
          html,
          /<tr[^>]*class="[^"]*\bathing\b[^"]*"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi
        ).map((match) => {
          const id = match[1] ?? '';
          const block = match[2] ?? '';
          const url = firstMatch(
            block,
            /<span[^>]*class="[^"]*titleline[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i
          );
          return {
            title:
              firstMatch(
                block,
                /<span[^>]*class="[^"]*titleline[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i
              ) ?? '',
            hot: compactHot(scores.get(id), '分'),
            url: absoluteUrl('https://news.ycombinator.com/', url),
          };
        })
      );
    },
  }),
  directSource({
    id: 'huxiu',
    label: '虎嗅',
    async fetch(signal) {
      const json = await fetchJson<HuxiuResponse>(
        'https://moment-api.huxiu.com/web-v3/moment/feed?platform=www',
        { signal, headers: { Referer: 'https://www.huxiu.com/moment/' } }
      );
      return withRanks(
        (json.data?.moment_list?.datalist ?? []).map((item) => {
          const lines = cleanText((item.content ?? '').replace(/<br\s*\/?>/gi, '\n'))
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          return {
            title: lines[0] ?? '',
            desc: lines.slice(1).join('\n') || undefined,
            author: item.user_info?.username,
            hot: compactHot(item.count_info?.agree_num),
            timestamp: normalizeTimestamp(item.publish_time),
            url: item.object_id ? `https://www.huxiu.com/moment/${item.object_id}.html` : undefined,
          };
        })
      );
    },
  }),
  directSource({
    id: 'ifanr',
    label: '爱范儿',
    async fetch(signal) {
      const json = await fetchJson<IfanrResponse>(
        'https://sso.ifanr.com/api/v5/wp/buzz/?limit=20&offset=0',
        { signal }
      );
      return withRanks(
        (json.objects ?? []).map((item) => ({
          title: item.post_title ?? '',
          desc: item.post_content,
          hot: compactHot(item.like_count || item.comment_count),
          timestamp: normalizeTimestamp(item.created_at),
          url:
            item.buzz_original_url ??
            (item.post_id ? `https://www.ifanr.com/${item.post_id}` : undefined),
        }))
      );
    },
  }),
  htmlListSource({
    id: 'ithome-xijiayi',
    label: 'IT之家「喜加一」',
    url: 'https://www.ithome.com/zt/xijiayi',
    blockPattern: /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    map(block) {
      const link = firstMatch(block, /<a[^>]+href="([^"]+)"/i);
      return {
        title: firstMatch(block, /<h2[^>]*>([\s\S]*?)<\/h2>/i) ?? '',
        desc: firstMatch(block, /<p[^>]*>([\s\S]*?)<\/p>/i),
        hot: compactHot(
          firstMatch(block, /<span[^>]*class="[^"]*comment[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
        ),
        timestamp: firstMatch(block, /<span[^>]*class="[^"]*time[^"]*"[^>]*>[\s\S]*?'([^']+)'/i),
        url: link,
      };
    },
  }),
  htmlListSource({
    id: 'jianshu',
    label: '简书',
    url: 'https://www.jianshu.com/',
    headers: { Referer: 'https://www.jianshu.com/' },
    blockPattern: /<li[^>]*id="[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
    map(block) {
      const href = firstMatch(block, /<a[^>]*class="[^"]*title[^"]*"[^>]*href="([^"]+)"/i);
      return {
        title: firstMatch(block, /<a[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ?? '',
        desc: firstMatch(block, /<p[^>]*class="[^"]*abstract[^"]*"[^>]*>([\s\S]*?)<\/p>/i),
        author: firstMatch(block, /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([\s\S]*?)<\/a>/i),
        url: absoluteUrl('https://www.jianshu.com/', href),
      };
    },
  }),
  rssSource('linuxdo', 'Linux.do', 'https://linux.do/top.rss?period=weekly'),
  directSource({
    id: 'miyoushe',
    label: '米游社',
    async fetch(signal) {
      const json = await fetchJson<MiyousheResponse>(
        'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?client_type=4&gids=5&last_id=&page_size=30&type=1',
        { signal }
      );
      return withRanks(
        (json.data?.list ?? []).map((item) => ({
          title: item.post?.subject ?? '',
          desc: item.post?.content,
          author: item.user?.nickname,
          hot: compactHot(item.post?.view_status),
          timestamp: normalizeTimestamp(item.post?.created_at),
          url: item.post?.post_id
            ? `https://www.miyoushe.com/ys/article/${item.post.post_id}`
            : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'netease-news',
    label: '网易新闻',
    async fetch(signal) {
      const json = await fetchJson<NeteaseResponse>('https://m.163.com/fe/api/hot/news/flow', {
        signal,
      });
      return withRanks(
        (json.data?.list ?? []).map((item) => ({
          title: item.title ?? '',
          author: item.source,
          timestamp: normalizeTimestamp(item.ptime),
          url: item.docid ? `https://www.163.com/dy/article/${item.docid}.html` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'newsmth',
    label: '水木社区',
    async fetch(signal) {
      const json = await fetchJson<NewsmthResponse>('https://wap.newsmth.net/wap/api/hot/global', {
        signal,
      });
      return withRanks(
        (json.data?.topics ?? []).map((topic) => {
          const article = topic.article ?? {};
          const url = article.topicId
            ? `https://wap.newsmth.net/article/${article.topicId}?title=${encodeURIComponent(topic.board?.title ?? '')}&from=home`
            : undefined;
          return {
            title: article.subject ?? '',
            desc: article.body,
            author: article.account?.name,
            timestamp: normalizeTimestamp(article.postTime),
            url,
          };
        })
      );
    },
  }),
  directSource({
    id: 'ngabbs',
    label: 'NGA',
    async fetch(signal) {
      const json = await fetchJson<NgaResponse>(
        'https://ngabbs.com/nuke.php?__lib=load_topic&__act=load_topic_reply_ladder2&opt=1&all=1',
        {
          signal,
          method: 'POST',
          headers: {
            Accept: '*/*',
            Referer: 'https://ngabbs.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-User-Agent': 'NGA_skull/7.3.1(iPhone13,2;iOS 17.2.1)',
          },
          body: new URLSearchParams({ __output: '14' }).toString(),
        }
      );
      return withRanks(
        (json.result?.[0] ?? []).map((item) => ({
          title: item.subject ?? '',
          author: item.author,
          hot: compactHot(item.replies, '回复'),
          timestamp: normalizeTimestamp(item.postdate),
          url: item.tpcurl ? `https://bbs.nga.cn${item.tpcurl}` : undefined,
        }))
      );
    },
  }),
  rssSource('nodeseek', 'NodeSeek', 'https://www.nodeseek.com/rss.xml'),
  rssSource('nytimes', '纽约时报', 'https://cn.nytimes.com/rss/', {
    headers: { 'User-Agent': MOBILE_UA },
  }),
  directSource({
    id: 'producthunt',
    label: 'Product Hunt',
    async fetch(signal) {
      const xml = await fetchText('https://www.producthunt.com/feed', {
        signal,
        headers: { 'User-Agent': DESKTOP_UA },
      });
      return withRanks(
        htmlBlocks(xml, /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi).map((block) => ({
          title: firstMatch(block, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? '',
          desc: stripHtml(firstMatch(block, /<content\b[^>]*>([\s\S]*?)<\/content>/i)),
          author: firstMatch(block, /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i),
          timestamp: normalizeTimestamp(
            firstMatch(block, /<published\b[^>]*>([\s\S]*?)<\/published>/i) ??
              firstMatch(block, /<updated\b[^>]*>([\s\S]*?)<\/updated>/i)
          ),
          url: firstMatch(block, /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i),
        }))
      );
    },
  }),
  directSource({
    id: 'qq-news',
    label: '腾讯新闻',
    async fetch(signal) {
      const json = await fetchJson<QqNewsResponse>(
        'https://r.inews.qq.com/gw/event/hot_ranking_list?page_size=50',
        { signal }
      );
      return withRanks(
        (json.idlist?.[0]?.newslist ?? []).slice(1).map((item) => ({
          title: item.title ?? '',
          desc: item.abstract,
          author: item.source,
          hot: compactHot(item.hotEvent?.hotScore),
          timestamp: normalizeTimestamp(item.timestamp),
          url: item.id ? `https://new.qq.com/rain/a/${item.id}` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'sina',
    label: '新浪网',
    async fetch(signal) {
      const json = await fetchJson<SinaResponse>(
        'https://newsapp.sina.cn/api/hotlist?newsId=HB-1-snhs%2Ftop_news_list-all',
        { signal }
      );
      return withRanks(
        (json.data?.hotList ?? []).map((item) => ({
          title: item.info?.title ?? '',
          hot: compactHot(parseChineseNumber(item.info?.hotValue)),
          url: item.base?.base?.url,
        }))
      );
    },
  }),
  directSource({
    id: 'sina-news',
    label: '新浪新闻',
    async fetch(signal) {
      const date = new Date();
      const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
      const text = await fetchText(
        `https://top.news.sina.com.cn/ws/GetTopDataList.php?top_type=day&top_cat=www_www_all_suda_suda&top_time=${ymd}&top_show_num=50`,
        { signal }
      );
      const json = parseSinaNewsJsonp(text);
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: item.title ?? '',
          author: item.media,
          hot: compactHot(Number((item.top_num ?? '').replace(/,/g, ''))),
          timestamp: normalizeTimestamp(
            `${item.create_date ?? ''} ${item.create_time ?? ''}`.trim()
          ),
          url: item.url,
        }))
      );
    },
  }),
  directSource({
    id: 'weread',
    label: '微信读书',
    async fetch(signal) {
      const json = await fetchJson<WereadResponse>(
        'https://weread.qq.com/web/bookListInCategory/rising?rank=1',
        { signal }
      );
      return withRanks(
        (json.books ?? []).map((item) => ({
          title: item.bookInfo?.title ?? '',
          desc: item.bookInfo?.intro,
          author: item.bookInfo?.author,
          hot: compactHot(item.readingCount, '阅读'),
          timestamp: normalizeTimestamp(item.bookInfo?.publishTime),
          url: item.bookInfo?.bookId
            ? `https://weread.qq.com/web/bookDetail/${wereadId(item.bookInfo.bookId)}`
            : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'yystv',
    label: '游研社',
    async fetch(signal) {
      const json = await fetchJson<YystvResponse>(
        'https://www.yystv.cn/home/get_home_docs_by_page',
        {
          signal,
          headers: {
            Accept: 'application/json,text/html,*/*',
            Referer: 'https://www.yystv.cn/docs',
            'User-Agent': DESKTOP_UA,
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      );
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: item.title ?? '',
          author: item.author,
          timestamp: normalizeTimestamp(item.createtime),
          url: item.id ? `https://www.yystv.cn/p/${item.id}` : undefined,
        }))
      );
    },
  }),
  directSource({
    id: 'zhihu-daily',
    label: '知乎日报',
    async fetch(signal) {
      const json = await fetchJson<ZhihuDailyResponse>(
        'https://daily.zhihu.com/api/4/news/latest',
        {
          signal,
          headers: { Referer: 'https://daily.zhihu.com/' },
        }
      );
      return withRanks(
        (json.stories ?? [])
          .filter((item) => item.type === 0)
          .map((item) => ({
            title: item.title ?? '',
            author: item.hint,
            url: item.url,
          }))
      );
    },
  }),
];

function directSource(def: DirectSourceDef): HotListSource {
  return {
    id: def.id,
    label: def.label,
    fetch: (ctx) => def.fetch(ctx.signal),
  };
}

function rssSource(
  id: DirectSourceId,
  label: string,
  url: string,
  opts: { encoding?: 'gbk' | 'utf-8'; headers?: Record<string, string> } = {}
): HotListSource {
  return directSource({
    id,
    label,
    async fetch(signal) {
      const xml =
        opts.encoding === 'gbk'
          ? decodeGbk(await fetchArrayBuffer(url, { signal, headers: opts.headers }))
          : await fetchText(url, { signal, headers: opts.headers });
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

function decodeGbk(value: ArrayBuffer): string {
  return new (TextDecoder as unknown as new (label: string) => TextDecoder)('gbk').decode(value);
}

function htmlListSource(def: {
  id: DirectSourceId;
  label: string;
  url: string;
  blockPattern: RegExp;
  headers?: Record<string, string>;
  map(block: string): Omit<HotListItem, 'rank'>;
}): HotListSource {
  return directSource({
    id: def.id,
    label: def.label,
    async fetch(signal) {
      const html = await fetchText(def.url, { signal, headers: def.headers });
      return withRanks(htmlBlocks(html, def.blockPattern).map((block) => def.map(block)));
    },
  });
}

function sign51cto(
  requestPath: string,
  payload: Record<string, string | number>,
  timestamp: number,
  token: string
): string {
  const params = { ...payload, timestamp, token };
  const sortedParams = Object.keys(params).sort();
  return md5(md5(requestPath) + md5(String(sortedParams) + md5(token) + timestamp));
}

function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

function coolapkHeaders(): Record<string, string> {
  const deviceId = [10, 6, 6, 6, 14]
    .map((len) => Math.random().toString(36).slice(2, len))
    .join('-');
  const now = Math.round(Date.now() / 1000);
  const md5Now = md5(String(now));
  const raw =
    'token://com.coolapk.market/c67ef5943784d09750dcfbb31020f0ab?' +
    md5Now +
    '$' +
    deviceId +
    '&com.coolapk.market';
  return {
    'X-Requested-With': 'XMLHttpRequest',
    'X-App-Id': 'com.coolapk.market',
    'X-App-Token': md5(Buffer.from(raw).toString('base64')) + deviceId + `0x${now.toString(16)}`,
    'X-Sdk-Int': '29',
    'X-Sdk-Locale': 'zh-CN',
    'X-App-Version': '11.0',
    'X-Api-Version': '11',
    'X-App-Code': '2101202',
    'User-Agent': COOLAPK_UA,
  };
}

function parseSinaNewsJsonp(text: string): SinaNewsJsonp {
  const raw = text
    .trim()
    .replace(/^var\s+data\s*=\s*/, '')
    .replace(/;\s*$/, '');
  return JSON.parse(raw) as SinaNewsJsonp;
}

function parseChineseNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/,/g, '').trim();
  const match = text.match(/([\d.]+)\s*([万亿])?/);
  if (!match?.[1]) return undefined;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n)) return undefined;
  if (match[2] === '亿') return n * 100_000_000;
  if (match[2] === '万') return n * 10_000;
  return n;
}

function wereadId(bookId: string): string {
  const hash = md5(bookId);
  let value = hash.slice(0, 3);
  const parts: string[] =
    /^\d*$/.test(bookId) && bookId.length > 0
      ? (bookId.match(/.{1,9}/g)?.map((item) => Number.parseInt(item, 10).toString(16)) ?? [])
      : [Array.from(bookId, (char) => char.charCodeAt(0).toString(16)).join('')];
  value += /^\d*$/.test(bookId) ? '3' : '4';
  value += `2${hash.slice(-2)}`;
  value += parts.map((part) => `${pad2(part.length.toString(16))}${part}`).join('g');
  if (value.length < 20) value += hash.slice(0, 20 - value.length);
  return value + md5(value).slice(0, 3);
}

function pad2(value: string | number): string {
  return String(value).padStart(2, '0');
}

interface CtoTokenResponse {
  data?: { data?: { token?: string } };
}

interface CtoResponse {
  data?: {
    data?: {
      list?: Array<{
        title?: string;
        abstract?: string;
        source_name?: string;
        pubdate?: string;
        url?: string;
      }>;
    };
  };
}

interface AcfunResponse {
  rankList?: Array<{
    dougaId?: string;
    contentTitle?: string;
    contentDesc?: string;
    userName?: string;
    contributeTime?: string;
    likeCount?: number;
  }>;
}

interface CsdnResponse {
  data?: Array<{
    articleTitle?: string;
    nickName?: string;
    period?: string;
    hotRankScore?: number;
    articleDetailUrl?: string;
  }>;
}

interface CoolapkResponse {
  data?: Array<{ message?: string; username?: string; ttitle?: string; shareUrl?: string }>;
}

interface DgtleResponse {
  items?: Array<{
    id?: string;
    title?: string;
    content?: string;
    from?: string;
    membernum?: number;
    created_at?: string;
    type?: string;
  }>;
}

interface GeekparkResponse {
  homepage_posts?: Array<{
    post?: {
      id?: string;
      title?: string;
      abstract?: string;
      views?: number;
      published_timestamp?: number;
      authors?: Array<{ nickname?: string }>;
    };
  }>;
}

interface GuokrItem {
  id?: string;
  title?: string;
  summary?: string;
  date_modified?: string;
  author?: { nickname?: string };
}

interface HuxiuResponse {
  data?: {
    moment_list?: {
      datalist?: Array<{
        content?: string;
        object_id?: string;
        publish_time?: string;
        user_info?: { username?: string };
        count_info?: { agree_num?: number };
      }>;
    };
  };
}

interface IfanrResponse {
  objects?: Array<{
    id?: string;
    post_title?: string;
    post_content?: string;
    created_at?: string;
    like_count?: number;
    comment_count?: number;
    buzz_original_url?: string;
    post_id?: string;
  }>;
}

interface MiyousheResponse {
  data?: {
    list?: Array<{
      post?: {
        post_id?: string;
        subject?: string;
        content?: string;
        created_at?: number;
        view_status?: number;
      };
      user?: { nickname?: string };
    }>;
  };
}

interface NewsmthResponse {
  data?: {
    topics?: Array<{
      firstArticleId?: string;
      board?: { title?: string };
      article?: {
        topicId?: string;
        subject?: string;
        body?: string;
        postTime?: string;
        account?: { name?: string };
      };
    }>;
  };
}

interface NgaResponse {
  result?: Array<
    Array<{
      subject?: string;
      author?: string;
      replies?: number;
      postdate?: string;
      tpcurl?: string;
    }>
  >;
}

interface SinaResponse {
  data?: {
    hotList?: Array<{
      base?: { base?: { uniqueId?: string; url?: string } };
      info?: { title?: string; hotValue?: string };
    }>;
  };
}

interface SinaNewsJsonp {
  data?: Array<{
    title?: string;
    media?: string;
    top_num?: string;
    create_date?: string;
    create_time?: string;
    url?: string;
  }>;
}

interface WereadResponse {
  books?: Array<{
    readingCount?: number;
    bookInfo?: {
      bookId?: string;
      title?: string;
      author?: string;
      intro?: string;
      publishTime?: string;
    };
  }>;
}

interface YystvResponse {
  data?: Array<{ id?: string; title?: string; author?: string; createtime?: string }>;
}

interface ZhihuDailyResponse {
  stories?: Array<{ id?: string; title?: string; hint?: string; type?: number; url?: string }>;
}
