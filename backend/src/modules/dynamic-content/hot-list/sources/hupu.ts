import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

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

export const hupuSource: HotListSource = {
  id: 'hupu',
  label: '虎扑',
  async fetch(ctx) {
    const json = await fetchJson<HupuResponse>(
      'https://m.hupu.com/api/v2/bbs/topicThreads?topicId=1&page=1',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data?.topicThreads ?? []).map((item) => ({
        title: item.title ?? '',
        author: item.username,
        hot: compactHot(item.replies, '回复'),
        url: item.tid ? `https://bbs.hupu.com/${item.tid}.html` : item.url,
      }))
    );
  },
};
