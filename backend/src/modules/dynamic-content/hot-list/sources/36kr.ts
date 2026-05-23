import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface KrResponse {
  data?: {
    hotRankList?: Array<{
      itemId?: string;
      templateMaterial?: {
        widgetTitle?: string;
        authorName?: string;
        statCollect?: number;
      };
    }>;
  };
}

export const kr36Source: HotListSource = {
  id: '36kr',
  label: '36氪',
  async fetch(ctx) {
    const json = await fetchJson<KrResponse>(
      'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot',
      {
        signal: ctx.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: {
          partner_id: 'wap',
          param: { siteId: 1, platformId: 2 },
          timestamp: Date.now(),
        },
      }
    );
    return withRanks(
      (json.data?.hotRankList ?? []).map((item) => ({
        title: item.templateMaterial?.widgetTitle ?? '',
        author: item.templateMaterial?.authorName,
        hot: compactHot(item.templateMaterial?.statCollect, '收藏'),
        url: item.itemId ? `https://www.36kr.com/p/${item.itemId}` : undefined,
      }))
    );
  },
};
