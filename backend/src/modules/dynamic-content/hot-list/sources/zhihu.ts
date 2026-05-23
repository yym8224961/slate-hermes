import type { HotListSource } from '../hot-list.types';
import { fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

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

export const zhihuSource: HotListSource = {
  id: 'zhihu',
  label: '知乎',
  async fetch(ctx) {
    const json = await fetchJson<ZhihuResponse>(
      'https://api.zhihu.com/topstory/hot-lists/total?limit=50',
      { signal: ctx.signal }
    );
    return withRanks(
      (json.data ?? []).map((item) => {
        const target = item.target ?? {};
        const questionId = target.url?.split('/').pop();
        return {
          title: target.title ?? '',
          desc: target.excerpt,
          hot: compactHot(parseZhihuHotValue(item.detail_text), '热度'),
          url: questionId ? `https://www.zhihu.com/question/${questionId}` : target.url,
        };
      })
    );
  },
};

function parseZhihuHotValue(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/,/g, '').match(/([\d.]+)\s*([万亿])?/);
  if (!match?.[1]) return undefined;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = match[2];
  if (unit === '亿') return n * 100_000_000;
  if (unit === '万') return n * 10_000;
  return n;
}
