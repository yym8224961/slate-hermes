import type { HotListSource } from '../hot-list.types';
import { DESKTOP_UA, fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface JuejinResponse {
  data?: Array<{
    content?: { content_id?: string; title?: string };
    author?: { name?: string };
    content_counter?: { hot_rank?: number };
  }>;
}

export const juejinSource: HotListSource = {
  id: 'juejin',
  label: '稀土掘金',
  async fetch(ctx) {
    const json = await fetchJson<JuejinResponse>(
      'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot',
      {
        signal: ctx.signal,
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: 'https://juejin.cn/hot/articles',
        },
      }
    );
    return withRanks(
      (json.data ?? []).map((item) => ({
        title: item.content?.title ?? '',
        author: item.author?.name,
        hot: compactHot(item.content_counter?.hot_rank, '热度'),
        url: item.content?.content_id
          ? `https://juejin.cn/post/${item.content.content_id}`
          : undefined,
      }))
    );
  },
};
