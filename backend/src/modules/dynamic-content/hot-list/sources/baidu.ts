import type { HotListSource } from '../hot-list.types';
import { fetchText } from '../fetch';
import { compactHot, pickJsonScript, withRanks } from '../text';

interface BaiduItem {
  word?: string;
  title?: string;
  desc?: string;
  show?: string;
  hotScore?: string;
  hotTag?: string;
  query?: string;
  rawUrl?: string;
  url?: string;
  content?: BaiduItem[];
}

interface BaiduSData {
  data?: { cards?: Array<{ content?: BaiduItem[] }> };
  cards?: Array<{ content?: BaiduItem[] }>;
}

export const baiduSource: HotListSource = {
  id: 'baidu',
  label: '百度热搜',
  async fetch(ctx) {
    const html = await fetchText('https://top.baidu.com/board?tab=realtime', {
      signal: ctx.signal,
    });
    const sData = pickJsonScript(html, /<!--s-data:(.*?)-->/s) as BaiduSData | null;
    const cardContent = sData?.data?.cards?.[0]?.content ?? sData?.cards?.[0]?.content ?? [];
    const list =
      cardContent.length > 0 && Array.isArray(cardContent[0]?.content)
        ? cardContent[0]!.content!
        : cardContent;
    return withRanks(
      list.map((item) => {
        const title = item.word ?? item.title ?? '';
        return {
          title,
          desc: item.desc,
          author: item.show,
          hot: compactHot(item.hotScore ?? item.hotTag),
          url:
            item.rawUrl ??
            item.url ??
            `https://www.baidu.com/s?wd=${encodeURIComponent(item.query ?? title)}`,
        };
      })
    );
  },
};
