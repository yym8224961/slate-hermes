import { defineJsonSource } from '../source-factory';
import { compactHot } from '../text';

interface SspaiResponse {
  data?: Array<{
    id?: string | number;
    title?: string;
    summary?: string;
    author?: { nickname?: string };
    like_count?: number;
  }>;
}

export const sspaiSource = defineJsonSource<SspaiResponse>({
  id: 'sspai',
  label: '少数派',
  url: 'https://sspai.com/api/v1/article/tag/page/get?limit=40&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0',
  map(json) {
    return (json.data ?? []).map((item) => ({
      title: item.title ?? '',
      desc: item.summary,
      author: item.author?.nickname,
      hot: compactHot(item.like_count, '喜欢'),
      url: item.id ? `https://sspai.com/post/${item.id}` : undefined,
    }));
  },
});
