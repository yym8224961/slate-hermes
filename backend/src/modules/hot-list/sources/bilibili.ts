import { DESKTOP_UA } from '../../../common/http/fetch';
import { defineJsonSource } from '../source-factory';
import { compactHot } from '../hot-list.utils';

interface BiliResponse {
  data?: {
    list?: Array<{
      bvid?: string;
      title?: string;
      desc?: string;
      owner?: { name?: string };
      stat?: { view?: number; like?: number };
      short_link_v2?: string;
    }>;
  };
}

export const bilibiliSource = defineJsonSource<BiliResponse>({
  id: 'bilibili',
  label: '哔哩哔哩',
  url: 'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1',
  options: {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': DESKTOP_UA,
    },
  },
  map(json) {
    return (json.data?.list ?? []).map((item) => ({
      title: item.title ?? '',
      desc: item.desc,
      author: item.owner?.name,
      hot: compactHot(item.stat?.view, '播放'),
      url:
        item.short_link_v2 ??
        (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : undefined),
    }));
  },
});
