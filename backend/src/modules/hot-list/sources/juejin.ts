import { DESKTOP_UA } from '../../../common/http/fetch';
import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

interface JuejinResponse {
  data?: Array<{
    content?: { content_id?: string; title?: string };
    author?: { name?: string };
    content_counter?: { hot_rank?: number };
  }>;
}

export const juejinSource = defineJsonSource<JuejinResponse>({
  id: 'juejin',
  label: '稀土掘金',
  url: 'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot',
  options: {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://juejin.cn/hot/articles',
    },
  },
  map(json) {
    return (json.data ?? []).map((item) => ({
      title: item.content?.title ?? '',
      author: item.author?.name,
      hot: compactHot(item.content_counter?.hot_rank, '热度'),
      url: item.content?.content_id
        ? `https://juejin.cn/post/${item.content.content_id}`
        : undefined,
    }));
  },
});
