import type { HotListSource } from '../hot-list.types';
import { DESKTOP_UA, fetchJson } from '../fetch';
import { withRanks } from '../text';

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

export const weiboSource: HotListSource = {
  id: 'weibo',
  label: '微博',
  async fetch(ctx) {
    const json = await fetchJson<WeiboResponse>('https://weibo.com/ajax/side/hotSearch', {
      signal: ctx.signal,
      headers: {
        Referer: 'https://weibo.com/',
        'User-Agent': DESKTOP_UA,
      },
    });
    return withRanks(
      (json.data?.realtime ?? []).map((item, index) => {
        const title = item.word ?? item.word_scheme ?? `热搜${index + 1}`;
        return {
          title,
          desc: item.note,
          url: `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`,
        };
      })
    );
  },
};
