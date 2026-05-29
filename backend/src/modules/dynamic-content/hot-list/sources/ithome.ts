import type { HotListSource } from '../hot-list.types';
import { fetchText } from '../fetch';
import { absoluteUrl, compactHot, cleanText, withRanks } from '../text';

export const ithomeSource: HotListSource = {
  id: 'ithome',
  label: 'IT之家',
  async fetch(ctx) {
    const html = await fetchText('https://m.ithome.com/rankm/', { signal: ctx.signal });
    const rows = Array.from(
      html.matchAll(
        /<div[^>]*class="[^"]*placeholder[^"]*"[^>]*data-news-id="[^"]*"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g
      )
    );
    return withRanks(
      uniqueIthomeItems(
        rows.map((match) => {
          const block = match[1] ?? '';
          const href = block.match(/<a[^>]+href="([^"]+)"/)?.[1];
          const title = cleanText(
            block.match(/class="[^"]*plc-title[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1]
          );
          const review = block.match(/class="[^"]*review-num[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/)?.[1];
          return {
            title,
            hot: compactHot(cleanText(review).replace(/\D/g, ''), '评'),
            url: href
              ? normalizeIthomeUrl(absoluteUrl('https://m.ithome.com/rankm/', href) ?? href)
              : undefined,
          };
        })
      )
    );
  },
};

function uniqueIthomeItems<T extends { title: string; url?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url ?? item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeIthomeUrl(url: string): string {
  const id = url.match(/(?:html|live)\/(\d+)\.htm/)?.[1];
  if (!id) return url;
  return `https://www.ithome.com/0/${id.slice(0, 3)}/${id.slice(3)}.htm`;
}
