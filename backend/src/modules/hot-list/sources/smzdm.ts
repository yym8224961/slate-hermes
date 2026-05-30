import type { HotListSource } from '../hot-list.types';
import { DESKTOP_UA, fetchJson, fetchText } from '../fetch';
import { firstMatch, htmlBlocks } from '../html';
import { compactHot, withRanks } from '../text';

interface SmzdmResponse {
  data?: Array<{
    title?: string;
    content?: string;
    nickname?: string;
    collection_count?: string | number;
    jump_link?: string;
  }>;
}

export const smzdmSource: HotListSource = {
  id: 'smzdm',
  label: '什么值得买',
  async fetch(ctx) {
    try {
      const json = await fetchJson<SmzdmResponse>('https://post.smzdm.com/rank/json_more/?unit=1', {
        signal: ctx.signal,
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: 'https://post.smzdm.com/hot_1/',
          'User-Agent': DESKTOP_UA,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      return withRanks(
        (json.data ?? []).map((item) => ({
          title: item.title ?? '',
          desc: item.content,
          author: item.nickname,
          hot: compactHot(item.collection_count, '收藏'),
          url: item.jump_link,
        }))
      );
    } catch {
      const html = await fetchText('https://post.smzdm.com/hot_1/', { signal: ctx.signal });
      return withRanks(
        htmlBlocks(html, /<h5[^>]*class="[^"]*z-feed-title[^"]*"[^>]*>([\s\S]*?)<\/h5>/gi).map(
          (block) => ({
            title: firstMatch(block, /<a[^>]*>([\s\S]*?)<\/a>/i) ?? '',
            url: firstMatch(block, /<a[^>]+href="([^"]+)"/i),
          })
        )
      );
    }
  },
};
