import { stripHtml as stripHtmlText } from '../html-text';

export interface RssItem {
  title?: string;
  link?: string;
  guid?: string;
  author?: string;
  pubDate?: string;
  content?: string;
  description?: string;
}

export function htmlBlocks(html: string, pattern: RegExp): string[] {
  return Array.from(html.matchAll(pattern), (match) => match[1] ?? '');
}

export function htmlBlockMatches(html: string, pattern: RegExp): RegExpMatchArray[] {
  return Array.from(html.matchAll(pattern));
}

export function firstMatch(text: string, pattern: RegExp): string | undefined {
  const value = text.match(pattern)?.[1];
  return value === undefined ? undefined : decodeHtml(value.trim());
}

export function attrValue(html: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  return (
    html.match(new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ??
    html.match(new RegExp(`\\s${escaped}\\s*=\\s*'([^']*)'`, 'i'))?.[1]
  );
}

export function jsonFromScript<T>(html: string, pattern: RegExp): T | null {
  const raw = html.match(pattern)?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(decodeHtml(raw)) as T;
  } catch {
    return null;
  }
}

export function decodeHtml(value: string): string {
  return stripHtmlText(value);
}

export function stripHtml(value: unknown): string {
  return stripHtmlText(String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

export function parseRss(xml: string): RssItem[] {
  return htmlBlocks(xml, /<item\b[^>]*>([\s\S]*?)<\/item>/gi).map((block) => ({
    title: xmlTag(block, 'title'),
    link: xmlTag(block, 'link'),
    guid: xmlTag(block, 'guid'),
    author: xmlTag(block, 'author') ?? xmlTag(block, 'dc:creator'),
    pubDate: xmlTag(block, 'pubDate'),
    content: xmlTag(block, 'content:encoded'),
    description: xmlTag(block, 'description'),
  }));
}

function xmlTag(block: string, tag: string): string | undefined {
  const escaped = escapeRegExp(tag);
  const raw = block.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'))?.[1];
  if (raw === undefined) return undefined;
  return stripHtml(raw).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
