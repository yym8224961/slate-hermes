import type { HotListItem } from './hot-list.types';

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactHot(value: unknown, suffix = ''): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') {
    const text = cleanText(value);
    if (!text || text === '0') return undefined;
    const numeric = Number(text.replace(/,/g, ''));
    if (Number.isFinite(numeric)) return compactHotNumber(numeric, suffix);
    return text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return undefined;
    return compactHotNumber(value, suffix);
  }
  return undefined;
}

export function compactHotNumber(value: number, suffix = ''): string {
  const n = Math.round(value);
  const unit =
    n >= 100_000_000
      ? `${trimDecimal(n / 100_000_000)}亿`
      : n >= 10_000
        ? `${trimDecimal(n / 10_000)}万`
        : String(n);
  return suffix ? `${unit}${suffix}` : unit;
}

export function withRanks(items: Array<Omit<HotListItem, 'rank'> | HotListItem>): HotListItem[] {
  return items
    .map((item, index) => ({
      ...item,
      rank: typeof (item as HotListItem).rank === 'number' ? (item as HotListItem).rank : index + 1,
      title: cleanText(item.title),
      hot: item.hot ? cleanText(item.hot) : undefined,
      desc: item.desc ? cleanText(item.desc) : undefined,
      author: item.author ? cleanText(item.author) : undefined,
      url: item.url ? String(item.url) : undefined,
      timestamp: item.timestamp ? String(item.timestamp) : undefined,
    }))
    .filter((item) => item.title.length > 0);
}

export function absoluteUrl(base: string, href: unknown): string | undefined {
  if (typeof href !== 'string' || !href.trim()) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

export function pickJsonScript(html: string, pattern: RegExp): unknown | null {
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '');
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const text = cleanText(value).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return normalizeTimestamp(numeric);
  const date = new Date(text.replace(/-/g, '/'));
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

export interface NeteaseResponse {
  data?: {
    list?: Array<{
      docid?: string;
      skipID?: string;
      title?: string;
      _keyword?: string;
      source?: string;
      publishTime?: string;
      ptime?: string;
      url?: string;
    }>;
  };
}

export interface QqNewsResponse {
  idlist?: Array<{
    newslist?: Array<{
      id?: string;
      title?: string;
      abstract?: string;
      source?: string;
      timestamp?: number;
      readCount?: number;
      hotEvent?: { hotScore?: number };
    }>;
  }>;
}
