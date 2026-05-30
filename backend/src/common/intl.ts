import { setBoundedCache } from './cache-utils';

const MAX_DATE_TIME_FORMAT_CACHE_ENTRIES = 256;
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

export function getDateTimeFormat(
  locales: string | string[],
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${localeKey(locales)}|${optionsKey(options)}`;
  const cached = dateTimeFormatCache.get(key);
  if (cached) {
    setBoundedCache(dateTimeFormatCache, key, cached, MAX_DATE_TIME_FORMAT_CACHE_ENTRIES);
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locales, options);
  setBoundedCache(dateTimeFormatCache, key, formatter, MAX_DATE_TIME_FORMAT_CACHE_ENTRIES);
  return formatter;
}

function localeKey(locales: string | string[]): string {
  return Array.isArray(locales) ? locales.join('\u0000') : locales;
}

function optionsKey(options: Intl.DateTimeFormatOptions): string {
  return JSON.stringify(Object.entries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
