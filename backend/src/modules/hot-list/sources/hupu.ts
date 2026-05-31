import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

interface HupuResponse {
  data?: {
    topicThreads?: Array<{
      tid?: string;
      title?: string;
      username?: string;
      replies?: number;
      url?: string;
    }>;
  };
}

export const hupuSource = defineJsonSource<HupuResponse>({
  id: 'hupu',
  label: '虎扑',
  url: 'https://m.hupu.com/api/v2/bbs/topicThreads?topicId=1&page=1',
  map(json) {
    return (json.data?.topicThreads ?? []).map((item) => ({
      title: item.title ?? '',
      author: item.username,
      hot: compactHot(item.replies, '回复'),
      url: item.tid ? `https://bbs.hupu.com/${item.tid}.html` : item.url,
    }));
  },
});
