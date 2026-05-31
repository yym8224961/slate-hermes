import { defineJsonSource } from '../source-factory';
import { compactHot, parseChineseNumber } from '../hot-list.utils';

interface ZhihuResponse {
  data?: Array<{
    target?: {
      id?: string;
      title?: string;
      excerpt?: string;
      url?: string;
    };
    detail_text?: string;
  }>;
}

export const zhihuSource = defineJsonSource<ZhihuResponse>({
  id: 'zhihu',
  label: '知乎',
  url: 'https://api.zhihu.com/topstory/hot-lists/total?limit=50',
  map(json) {
    return (json.data ?? []).map((item) => {
      const target = item.target ?? {};
      const questionId = target.url?.split('/').pop();
      return {
        title: target.title ?? '',
        desc: target.excerpt,
        hot: compactHot(parseChineseNumber(item.detail_text), '热度'),
        url: questionId ? `https://www.zhihu.com/question/${questionId}` : target.url,
      };
    });
  },
});
