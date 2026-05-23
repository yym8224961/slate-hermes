import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface ThepaperResponse {
  data?: {
    hotNews?: Array<{
      contId?: string;
      name?: string;
      praiseTimes?: string | number;
    }>;
  };
}

export const thepaperSource: HotListSource = {
  id: 'thepaper',
  label: '澎湃新闻',
  async fetch(ctx) {
    const json = await fetchJson<ThepaperResponse>(
      'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data?.hotNews ?? []).map((item) => ({
        title: item.name ?? '',
        hot: compactHot(item.praiseTimes),
        url: item.contId ? `https://www.thepaper.cn/newsDetail_forward_${item.contId}` : undefined,
      }))
    );
  },
};
