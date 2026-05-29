import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface V2exItem {
  id?: string | number;
  title?: string;
  content?: string;
  member?: { username?: string };
  replies?: number;
  url?: string;
}

export const v2exSource: HotListSource = {
  id: 'v2ex',
  label: 'V2EX',
  async fetch(ctx) {
    const list = await fetchJson<V2exItem[]>('https://www.v2ex.com/api/topics/hot.json', {
      signal: ctx.signal,
    });
    const items = Array.isArray(list) ? list : [];
    return withRanks(
      items.map((item) => ({
        title: item.title ?? '',
        desc: item.content,
        author: item.member?.username,
        hot: compactHot(item.replies, '回复'),
        url: item.url,
      }))
    );
  },
};
