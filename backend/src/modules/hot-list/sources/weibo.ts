import { DESKTOP_UA } from '../fetch';
import { defineJsonSource } from '../source-factory';

interface WeiboResponse {
  data?: {
    realtime?: Array<{
      mid?: string;
      word?: string;
      word_scheme?: string;
      note?: string;
    }>;
  };
}

export const weiboSource = defineJsonSource<WeiboResponse>({
  id: 'weibo',
  label: '微博',
  url: 'https://weibo.com/ajax/side/hotSearch',
  options: {
    headers: {
      Referer: 'https://weibo.com/',
      'User-Agent': DESKTOP_UA,
    },
  },
  map(json) {
    return (json.data?.realtime ?? []).map((item, index) => {
      const title = item.word ?? item.word_scheme ?? `热搜${index + 1}`;
      return {
        title,
        desc: item.note,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`,
      };
    });
  },
});
