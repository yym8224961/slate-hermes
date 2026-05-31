import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

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

export const kr36Source = defineJsonSource<KrResponse>({
  id: '36kr',
  label: '36氪',
  url: 'https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot',
  options: () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: {
      partner_id: 'wap',
      param: { siteId: 1, platformId: 2 },
      timestamp: Date.now(),
    },
  }),
  map(json) {
    return (json.data?.hotRankList ?? []).map((item) => ({
      title: item.templateMaterial?.widgetTitle ?? '',
      author: item.templateMaterial?.authorName,
      hot: compactHot(item.templateMaterial?.statCollect, '收藏'),
      url: item.itemId ? `https://www.36kr.com/p/${item.itemId}` : undefined,
    }));
  },
});
