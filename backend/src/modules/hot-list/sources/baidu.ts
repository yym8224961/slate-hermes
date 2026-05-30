import { defineTextSource } from '../source-factory';
import { jsonFromScript } from '../html';
import { compactHot } from '../text';

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

export const baiduSource = defineTextSource({
  id: 'baidu',
  label: '百度热搜',
  url: 'https://top.baidu.com/board?tab=realtime',
  map(html) {
    const sData = jsonFromScript<BaiduSData>(html, /<!--s-data:(.*?)-->/s);
    const cardContent = sData?.data?.cards?.[0]?.content ?? sData?.cards?.[0]?.content ?? [];
    const list =
      cardContent.length > 0 && Array.isArray(cardContent[0]?.content)
        ? cardContent[0]!.content!
        : cardContent;
    return list.map((item) => {
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
    });
  },
});
