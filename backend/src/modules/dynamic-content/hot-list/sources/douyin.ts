import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface DouyinResponse {
  data?: {
    word_list?: Array<{
      sentence_id?: string;
      word?: string;
      hot_value?: number;
    }>;
  };
}

export const douyinSource: HotListSource = {
  id: 'douyin',
  label: '抖音',
  async fetch(ctx) {
    const json = await fetchJson<DouyinResponse>(
      'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data?.word_list ?? []).map((item) => ({
        title: item.word ?? '',
        hot: compactHot(item.hot_value, '热度'),
        url: item.sentence_id ? `https://www.douyin.com/hot/${item.sentence_id}` : undefined,
      }))
    );
  },
};
