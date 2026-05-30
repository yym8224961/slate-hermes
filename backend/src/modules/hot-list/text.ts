import { TextDecoder } from 'node:util';
import type { HotListItem } from './hot-list.types';
import { stripHtml } from '../../common/html-text';
import { isPublicHttpUrl } from '../../common/http/fetch';

export function decodeGbk(value: ArrayBuffer): string {
  return new TextDecoder('gbk').decode(value);
}

export function compactHot(value: unknown, suffix = ''): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') {
    const text = stripHtml(value);
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
      title: stripHtml(item.title),
      hot: item.hot ? stripHtml(item.hot) : undefined,
      desc: item.desc ? stripHtml(item.desc) : undefined,
      author: item.author ? stripHtml(item.author) : undefined,
      url: safeExternalUrl(item.url),
      timestamp: item.timestamp ? String(item.timestamp) : undefined,
    }))
    .filter((item) => item.title.length > 0);
}

export function absoluteUrl(base: string, href: unknown): string | undefined {
  if (typeof href !== 'string' || !href.trim()) return undefined;
  try {
    return safeExternalUrl(new URL(href, base).toString());
  } catch {
    return undefined;
  }
}

export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return isPublicHttpUrl(url.toString()) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '');
}

export function parseChineseNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/,/g, '').trim();
  const match = text.match(/([\d.]+)\s*([万亿])?/);
  if (!match?.[1]) return undefined;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (match[2] === '亿') return n * 100_000_000;
  if (match[2] === '万') return n * 10_000;
  return n;
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const text = stripHtml(value).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return normalizeTimestamp(numeric);
  const date = new Date(text.replace(/-/g, '/'));
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}
