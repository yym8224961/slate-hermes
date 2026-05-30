import { defineJsonSource } from '../source-factory';
import { compactHot } from '../text';

interface DouyinResponse {
  data?: { word_list?: DouyinWordItem[] };
  word_list?: DouyinWordItem[];
}

interface DouyinWordItem {
  group_id?: string;
  sentence_id?: string;
  word?: string;
  hot_value?: number;
}

export const douyinSource = defineJsonSource<DouyinResponse>({
  id: 'douyin',
  label: '抖音',
  url: 'https://aweme.snssdk.com/aweme/v1/hot/search/list/',
  map(json) {
    return (json.data?.word_list ?? json.word_list ?? []).map((item) => ({
      title: item.word ?? '',
      hot: compactHot(item.hot_value, '热度'),
      url: item.sentence_id
        ? `https://www.douyin.com/hot/${item.sentence_id}`
        : item.group_id
          ? `https://www.douyin.com/hot/${item.group_id}`
          : undefined,
    }));
  },
});
