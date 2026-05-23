import { z } from 'zod';

export const HistoryTodayItemSchema = z.object({
  year: z
    .string()
    .trim()
    .regex(/^(?:前)?[1-9]\d{0,3}$/),
  display: z.string().trim().min(1).max(120),
});

export const HistoryTodayDataSchema = z.object({
  dateLabel: z.string().trim().min(1).max(24),
  items: z.array(HistoryTodayItemSchema).min(1),
});

export type HistoryTodayItem = z.infer<typeof HistoryTodayItemSchema>;
export type HistoryTodayProviderData = z.infer<typeof HistoryTodayDataSchema>;

export function parseHistoryTodayData(value: unknown): HistoryTodayProviderData | null {
  const parsed = HistoryTodayDataSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    items: [...parsed.data.items]
      .sort((a, b) => historyYearSortKey(b.year) - historyYearSortKey(a.year))
      .slice(0, 5),
  };
}

export function normalizeHistoryYear(value: string): string | null {
  const text = value
    .trim()
    .replace(/\s+/g, '')
    .replace(/^公元前/, '前')
    .replace(/^公元/, '')
    .replace(/^-/, '前')
    .replace(/年$/g, '');
  const match = text.match(/^(前)?(\d{1,4})$/);
  if (!match) return null;
  const normalizedNumber = String(Number(match[2]));
  if (normalizedNumber === '0' || normalizedNumber.length > 4) return null;
  return `${match[1] ?? ''}${normalizedNumber}`;
}

function historyYearSortKey(year: string): number {
  return year.startsWith('前') ? -Number(year.slice(1)) : Number(year);
}
