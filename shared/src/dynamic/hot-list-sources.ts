import { z } from 'zod';

export type HotListSourceKindT = 'general' | 'news' | 'tech' | 'community' | 'commerce';

export interface HotListSourceCatalogEntry {
  id: HotListSourceIdT;
  label: string;
  shortLabel: string;
  kind: HotListSourceKindT;
  channelLabel?: string;
}

export const HotListSourceIdValues = [
  'zhihu',
  'weibo',
  'baidu',
  'v2ex',
  'bilibili',
  'toutiao',
  'thepaper',
  'douyin',
  'kuaishou',
  'hupu',
  'tieba',
  'juejin',
  'sspai',
  'ithome',
  'smzdm',
  '36kr',
  'baidutieba',
  'dongchedi',
  'douban-movic',
  'github-trending',
  'hello-github',
  'netease',
  'netease-music',
  'qq',
  'quark',
  'woshipm',
  'xiaohongshu',
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
] as const;

export const HotListSourceId = z.enum(HotListSourceIdValues);
export type HotListSourceIdT = z.infer<typeof HotListSourceId>;

function hotListSource<const Id extends HotListSourceIdT>(
  id: Id,
  label: string,
  kind: HotListSourceKindT,
  shortLabel: string = label,
  channelLabel?: string
): HotListSourceCatalogEntry {
  return { id, label, shortLabel, kind, ...(channelLabel ? { channelLabel } : {}) };
}

const G: HotListSourceKindT = 'general';
const N: HotListSourceKindT = 'news';
const T: HotListSourceKindT = 'tech';
const C: HotListSourceKindT = 'community';
const M: HotListSourceKindT = 'commerce';

export const HOT_LIST_SOURCES = [
  hotListSource('zhihu', '知乎', G, '知乎热榜', '热榜'),
  hotListSource('weibo', '微博', G, '微博热搜', '热搜榜'),
  hotListSource('baidu', '百度热搜', G, '百度热搜', '热搜榜'),
  hotListSource('v2ex', 'V2EX', C, 'V2EX热门', '热门主题'),
  hotListSource('bilibili', '哔哩哔哩', G, 'B站热门视频', '热门视频'),
  hotListSource('toutiao', '今日头条', N, '头条'),
  hotListSource('thepaper', '澎湃新闻', N, '澎湃'),
  hotListSource('douyin', '抖音', G),
  hotListSource('kuaishou', '快手', G),
  hotListSource('hupu', '虎扑', C),
  hotListSource('tieba', '百度贴吧', C, '贴吧热议', '热议话题'),
  hotListSource('juejin', '稀土掘金', T, '掘金'),
  hotListSource('sspai', '少数派', T),
  hotListSource('ithome', 'IT之家', T),
  hotListSource('smzdm', '什么值得买', M, '值得买'),
  hotListSource('36kr', '36氪', T, '36氪热榜', '热榜'),

  hotListSource('baidutieba', '百度贴吧', C, '贴吧热议榜', '热议榜'),
  hotListSource('dongchedi', '懂车帝', G),
  hotListSource('douban-movic', '豆瓣电影', G, '豆瓣新片', '新片榜（Next）'),
  hotListSource('github-trending', 'GitHub', T, 'GitHub热门仓库', '热门仓库'),
  hotListSource('hello-github', 'HelloGitHub', T, 'HelloGitHub精选', '精选'),
  hotListSource('netease', '网易新闻', N, '网易热榜', '热榜（Next）'),
  hotListSource('netease-music', '网易云音乐', G, '网易云热歌'),
  hotListSource('qq', '腾讯新闻', C, '腾讯热点', '热点榜（Next）'),
  hotListSource('quark', '夸克', T, '夸克热点'),
  hotListSource('woshipm', '人人都是产品经理', T, '人人都是产品经理'),
  hotListSource('xiaohongshu', '小红书', C),

  hotListSource('51cto', '51CTO', T),
  hotListSource('52pojie', '吾爱破解', C),
  hotListSource('acfun', 'AcFun', G),
  hotListSource('csdn', 'CSDN', T),
  hotListSource('coolapk', '酷安', T),
  hotListSource('dgtle', '数字尾巴', T),
  hotListSource('douban-group', '豆瓣讨论小组', C, '豆瓣小组'),
  hotListSource('douban-movie', '豆瓣电影', G, '豆瓣新片', '新片榜（DailyHot）'),
  hotListSource('gameres', 'GameRes 游资网', T),
  hotListSource('geekpark', '极客公园', T),
  hotListSource('guokr', '果壳', T),
  hotListSource('hackernews', 'Hacker News', T),
  hotListSource('hostloc', '全球主机交流', C, 'Hostloc'),
  hotListSource('huxiu', '虎嗅', N, '虎嗅24小时'),
  hotListSource('ifanr', '爱范儿', N, '爱范儿快讯'),
  hotListSource('ithome-xijiayi', 'IT之家「喜加一」', T, 'IT之家喜加一'),
  hotListSource('jianshu', '简书', T),
  hotListSource('linuxdo', 'Linux.do', C),
  hotListSource('miyoushe', '米游社', C),
  hotListSource('netease-news', '网易新闻', N, '网易热点榜', '热点榜（DailyHot）'),
  hotListSource('newsmth', '水木社区', C, '水木'),
  hotListSource('ngabbs', 'NGA', C),
  hotListSource('nodeseek', 'NodeSeek', C),
  hotListSource('nytimes', '纽约时报', N, '纽约时报'),
  hotListSource('producthunt', 'Product Hunt', T),
  hotListSource('qq-news', '腾讯新闻', N, '腾讯热点榜', '热点榜（DailyHot）'),
  hotListSource('sina', '新浪网', N, '新浪网'),
  hotListSource('sina-news', '新浪新闻', N, '新浪新闻'),
  hotListSource('weread', '微信读书', G),
  hotListSource('yystv', '游研社', G),
  hotListSource('zhihu-daily', '知乎日报', N, '知乎日报'),

  hotListSource('36kr-quick', '36氪', T, '36氪快讯', '快讯'),
  hotListSource('bilibili-hot-search', '哔哩哔哩', C, 'B站热搜', '热搜'),
  hotListSource('bilibili-hot-video', '哔哩哔哩', C, 'B站热门视频', '热门视频（NewsNow）'),
  hotListSource('bilibili-ranking', '哔哩哔哩', C, 'B站排行榜', '排行榜'),
  hotListSource('cankaoxiaoxi', '参考消息', N, '参考消息'),
  hotListSource('douban', '豆瓣', G, '豆瓣热门'),
  hotListSource('chongbuluo', '虫部落', C, '虫部落首页', '首页'),
  hotListSource('chongbuluo-hot', '虫部落', C, '虫部落最热', '最热'),
  hotListSource('chongbuluo-latest', '虫部落', C, '虫部落最新', '最新'),
  hotListSource('cls', '财联社', N, '财联社电报', '电报（默认）'),
  hotListSource('cls-depth', '财联社', N, '财联社深度', '深度'),
  hotListSource('cls-hot', '财联社', N, '财联社热门', '热门'),
  hotListSource('cls-telegraph', '财联社', N, '财联社电报', '电报'),
  hotListSource('fastbull', '法布财经', N, 'FastBull快讯', '快讯'),
  hotListSource('fastbull-express', '法布财经', N, 'FastBull快线', '快线'),
  hotListSource('fastbull-news', '法布财经', N, 'FastBull头条', '头条'),
  hotListSource('freebuf', 'FreeBuf', T),
  hotListSource('gelonghui', '格隆汇', N),
  hotListSource('ifeng', '凤凰网', N, '凤凰网'),
  hotListSource('iqiyi', '爱奇艺', G, '爱奇艺热播榜', '热播榜（默认）'),
  hotListSource('iqiyi-hot-ranklist', '爱奇艺', G, '爱奇艺热播榜', '热播榜'),
  hotListSource('jin10', '金十数据', N, '金十'),
  hotListSource('kaopu', '靠谱新闻', N, '靠谱'),
  hotListSource('mktnews', 'MKTNews', N, 'MKTNews快讯', '快讯（默认）'),
  hotListSource('mktnews-flash', 'MKTNews', N, 'MKTNews快讯', '快讯'),
  hotListSource('nowcoder', '牛客', C),
  hotListSource('pcbeta', '远景论坛', C, '远景Win11', 'Windows 11'),
  hotListSource('pcbeta-windows11', '远景论坛', C, '远景Win11热帖', 'Windows 11 热帖'),
  hotListSource('solidot', 'Solidot', T),
  hotListSource('sputniknewscn', '卫星通讯社', N, '卫星通讯社'),
  hotListSource('steam', 'Steam', G),
  hotListSource('tencent', '腾讯新闻', N, '腾讯综合早报', '综合早报（默认）'),
  hotListSource('tencent-hot', '腾讯新闻', N, '腾讯综合早报', '综合早报'),
  hotListSource('v2ex-share', 'V2EX', C, 'V2EX最新分享', '最新分享'),
  hotListSource('wallstreetcn', '华尔街见闻', N, '华尔街快讯', '快讯（默认）'),
  hotListSource('wallstreetcn-hot', '华尔街见闻', N, '华尔街最热', '最热'),
  hotListSource('wallstreetcn-news', '华尔街见闻', N, '华尔街最新', '最新'),
  hotListSource('wallstreetcn-quick', '华尔街见闻', N, '华尔街快讯', '快讯'),
  hotListSource('xueqiu', '雪球', N, '雪球热门股票', '热门股票（默认）'),
  hotListSource('xueqiu-hotstock', '雪球', N, '雪球热门股票', '热门股票'),
  hotListSource('zaobao', '联合早报', N, '联合早报'),
  hotListSource('qqvideo', '腾讯视频', G, '腾讯视频热搜榜', '电视热搜榜（默认）'),
  hotListSource('qqvideo-tv-hotsearch', '腾讯视频', G, '腾讯视频电视热搜榜', '电视热搜榜'),
] as const satisfies readonly HotListSourceCatalogEntry[];

export function hotListSourceLabel(source: HotListSourceIdT): string {
  return HOT_LIST_SOURCES.find((item) => item.id === source)?.label ?? source;
}

export function hotListSourceDisplayLabel(source: HotListSourceCatalogEntry): string {
  return source.channelLabel ? `${source.label} · ${source.channelLabel}` : source.label;
}

const HOT_LIST_SOURCE_COLLATOR = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
});

export const HOT_LIST_SOURCES_BY_NAME = [...HOT_LIST_SOURCES].sort((a, b) =>
  HOT_LIST_SOURCE_COLLATOR.compare(hotListSourceDisplayLabel(a), hotListSourceDisplayLabel(b))
);

export function hotListSourceShortLabel(source: HotListSourceIdT): string {
  return HOT_LIST_SOURCES.find((item) => item.id === source)?.shortLabel ?? source;
}

export const HotListConfig = z.object({
  type: z.literal('hot_list'),
  source: HotListSourceId.default('weibo'),
  refresh_interval_sec: z.coerce.number().int().min(300).max(86400).default(600),
});
export type HotListConfigT = z.infer<typeof HotListConfig>;
