import { pickText } from './frame-value-utils';

export function monthFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  const parts = text.split(/[/-]/);
  if (parts.length < 2) return formatDatePart(fallback, 'monthDay', timeZone).split('/')[0] ?? '1';
  return String(Number(parts[0] ?? 1));
}

export function dayFromMonthDay(value: unknown, fallback: Date, timeZone: string): string {
  const text = pickText(value, formatDatePart(fallback, 'monthDay', timeZone));
  return String(Number(text.split(/[/-]/)[1] ?? text));
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
    date = parseDateLike(value);
  }
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function parseDateLike(value: string): Date {
  const text = value.trim();
  const candidates = new Set<string>([text]);
  candidates.add(text.replace(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/, '$1T$2'));

  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    candidates.add(candidate.replace(/([+-]\d{2})$/, '$1:00'));
  }

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Number.NaN);
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

export function dateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
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
