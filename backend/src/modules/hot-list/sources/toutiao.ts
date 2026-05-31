import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

interface ToutiaoResponse {
  data?: Array<{
    ClusterIdStr?: string;
    Title?: string;
    HotValue?: string | number;
  }>;
}

export const toutiaoSource = defineJsonSource<ToutiaoResponse>({
  id: 'toutiao',
  label: '今日头条',
  url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
  map(json) {
    return (json.data ?? []).map((item) => ({
      title: item.Title ?? '',
      hot: compactHot(item.HotValue, '热度'),
      url: item.ClusterIdStr ? `https://www.toutiao.com/trending/${item.ClusterIdStr}/` : undefined,
    }));
  },
});
