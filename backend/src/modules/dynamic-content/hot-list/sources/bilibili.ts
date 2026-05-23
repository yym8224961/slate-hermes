import type { HotListSource } from '../hot-list.types';
import { DESKTOP_UA, fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

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

export const bilibiliSource: HotListSource = {
  id: 'bilibili',
  label: '哔哩哔哩',
  async fetch(ctx) {
    const json = await fetchJson<BiliResponse>(
      'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1',
      {
        signal: ctx.signal,
        headers: {
          Referer: 'https://www.bilibili.com/',
          'User-Agent': DESKTOP_UA,
        },
      }
    );
    return withRanks(
      (json.data?.list ?? []).map((item) => ({
        title: item.title ?? '',
        desc: item.desc,
        author: item.owner?.name,
        hot: compactHot(item.stat?.view, '播放'),
        url:
          item.short_link_v2 ??
          (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : undefined),
      }))
    );
  },
};
