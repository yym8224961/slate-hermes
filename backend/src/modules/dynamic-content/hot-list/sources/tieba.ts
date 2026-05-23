import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface TiebaResponse {
  data?: {
    bang_topic?: {
      topic_list?: Array<{
        topic_name?: string;
        topic_desc?: string;
        discuss_num?: number;
        topic_url?: string;
      }>;
    };
  };
}

export const tiebaSource: HotListSource = {
  id: 'tieba',
  label: '百度贴吧',
  async fetch(ctx) {
    const json = await fetchJson<TiebaResponse>(
      'https://tieba.baidu.com/hottopic/browse/topicList',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data?.bang_topic?.topic_list ?? []).map((item) => ({
        title: item.topic_name ?? '',
        desc: item.topic_desc,
        hot: compactHot(item.discuss_num, '讨论'),
        url: item.topic_url,
      }))
    );
  },
};
