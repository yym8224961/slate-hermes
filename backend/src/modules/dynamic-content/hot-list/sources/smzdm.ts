import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface SmzdmResponse {
  data?: Array<{
    title?: string;
    content?: string;
    nickname?: string;
    collection_count?: string | number;
    jump_link?: string;
  }>;
}

export const smzdmSource: HotListSource = {
  id: 'smzdm',
  label: '什么值得买',
  async fetch(ctx) {
    const json = await fetchJson<SmzdmResponse>('https://post.smzdm.com/rank/json_more/?unit=1', {
      signal: ctx.signal,
    });
    return withRanks(
      (json.data ?? []).map((item) => ({
        title: item.title ?? '',
        desc: item.content,
        author: item.nickname,
        hot: compactHot(item.collection_count, '收藏'),
        url: item.jump_link,
      }))
    );
  },
};
