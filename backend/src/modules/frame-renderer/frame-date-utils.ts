import { pickText } from './frame-value-utils';
import { utcFromWallTimeInTz } from '../dynamic-content/timezone';

export function monthFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const parsed = parseMonthDay(value);
  if (parsed) return String(parsed.month);
  return formatDatePart(fallback, 'monthDay', timeZone).split('/')[0] ?? '1';
}

export function dayFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const parsed = parseMonthDay(value);
  if (parsed) return String(parsed.day);
  return formatDatePart(fallback, 'monthDay', timeZone).split('/')[1] ?? '1';
}

function parseMonthDay(value: unknown): { month: number; day: number } | null {
  const text = pickText(value, '').trim();
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

export function formatDatePart(
  date: Date,
  mode: 'year' | 'monthDay' | 'cnMonthDay',
  timeZone: string
): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  if (mode === 'year') return year;
  if (mode === 'cnMonthDay') return `${Number(month)} 月 ${Number(day)} 日`;
  return `${month}/${day}`;
}

export function formatShortTime(value: unknown, fallback: Date, timeZone: string): string {
  let date = fallback;
  if (typeof value === 'string') {
    date = parseDateLike(value, timeZone);
  }
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function parseDateLike(value: string, timeZone = 'UTC'): Date {
  const text = value.trim();
  const candidates = new Set<string>([text]);
  candidates.add(text.replace(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2})/, '$1T$2'));

  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    candidates.add(candidate.replace(/([+-]\d{2})$/, '$1:00'));
  }

  for (const candidate of candidates) {
    if (!hasExplicitTimeZone(candidate)) {
      const wallTime = parseWallTimeInZone(candidate, timeZone);
      if (wallTime) return wallTime;
    }
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Number.NaN);
}

function hasExplicitTimeZone(value: string): boolean {
  const text = value.trim();
  if (/[zZ]$/.test(text)) return true;
  return /(?:T|\s)\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?[+-]\d{2}(?::?\d{2})?$/.test(text);
}

function parseWallTimeInZone(value: string, timeZone: string): Date | null {
  const match = value.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
  );
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0'] = match;
  const paddedMs = ms.padEnd(3, '0');
  return utcFromWallTimeInTz(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s),
      millisecond: Number(paddedMs),
    },
    timeZone
  );
}

export function shortEarthquakeTime(value: string): string {
  const match = value.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (match) return `${Number(match[1])}/${Number(match[2])} ${match[3]}:${match[4]}`;
  const fallback = value.match(/(\d{1,2}):(\d{2})/);
  return fallback ? `${fallback[1]}:${fallback[2]}` : value;
}

export function weekdayFor(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value ?? 1970),
    month: Number(parts.find((p) => p.type === 'month')?.value ?? 1),
    day: Number(parts.find((p) => p.type === 'day')?.value ?? 1),
  };
}
