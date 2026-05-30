import { defineJsonSource } from '../source-factory';
import { compactHot } from '../text';

interface ThepaperResponse {
  data?: {
    hotNews?: Array<{
      contId?: string;
      name?: string;
      praiseTimes?: string | number;
    }>;
  };
}

export const thepaperSource = defineJsonSource<ThepaperResponse>({
  id: 'thepaper',
  label: '澎湃新闻',
  url: 'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar',
  map(json) {
    return (json.data?.hotNews ?? []).map((item) => ({
      title: item.name ?? '',
      hot: compactHot(item.praiseTimes),
      url: item.contId ? `https://www.thepaper.cn/newsDetail_forward_${item.contId}` : undefined,
    }));
  },
});
