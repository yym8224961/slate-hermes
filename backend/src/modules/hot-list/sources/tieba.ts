import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

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

export const tiebaSource = defineJsonSource<TiebaResponse>({
  id: 'tieba',
  label: '百度贴吧',
  url: 'https://tieba.baidu.com/hottopic/browse/topicList',
  map(json) {
    return (json.data?.bang_topic?.topic_list ?? []).map((item) => ({
      title: item.topic_name ?? '',
      desc: item.topic_desc,
      hot: compactHot(item.discuss_num, '讨论'),
      url: item.topic_url,
    }));
  },
});
