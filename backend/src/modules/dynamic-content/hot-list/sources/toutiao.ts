import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface ToutiaoResponse {
  data?: Array<{
    ClusterIdStr?: string;
    Title?: string;
    HotValue?: string | number;
  }>;
}

export const toutiaoSource: HotListSource = {
  id: 'toutiao',
  label: '今日头条',
  async fetch(ctx) {
    const json = await fetchJson<ToutiaoResponse>(
      'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data ?? []).map((item) => ({
        title: item.Title ?? '',
        hot: compactHot(item.HotValue, '热度'),
        url: item.ClusterIdStr
          ? `https://www.toutiao.com/trending/${item.ClusterIdStr}/`
          : undefined,
      }))
    );
  },
};
