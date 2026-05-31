import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

interface V2exItem {
  id?: string | number;
  title?: string;
  content?: string;
  member?: { username?: string };
  replies?: number;
  url?: string;
}

export const v2exSource = defineJsonSource<V2exItem[]>({
  id: 'v2ex',
  label: 'V2EX',
  url: 'https://www.v2ex.com/api/topics/hot.json',
  map(list) {
    const items = Array.isArray(list) ? list : [];
    return items.map((item) => ({
      title: item.title ?? '',
      desc: item.content,
      author: item.member?.username,
      hot: compactHot(item.replies, '回复'),
      url: item.url,
    }));
  },
});
