import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface SspaiResponse {
  data?: Array<{
    id?: string | number;
    title?: string;
    summary?: string;
    author?: { nickname?: string };
    like_count?: number;
  }>;
}

export const sspaiSource: HotListSource = {
  id: 'sspai',
  label: '少数派',
  async fetch(ctx) {
    const json = await fetchJson<SspaiResponse>(
      'https://sspai.com/api/v1/article/tag/page/get?limit=40&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data ?? []).map((item) => ({
        title: item.title ?? '',
        desc: item.summary,
        author: item.author?.nickname,
        hot: compactHot(item.like_count, '喜欢'),
        url: item.id ? `https://sspai.com/post/${item.id}` : undefined,
      }))
    );
  },
};
