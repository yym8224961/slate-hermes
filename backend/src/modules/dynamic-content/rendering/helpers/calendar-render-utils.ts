import { traditionalFestivalShortName } from '../../traditional-festivals';
import { parseHistoryTodayData } from '../../history-today.data';
import { isRecord, limitChars, pickText } from './frame-value-utils';

export function readHistoryItems(
  data: Record<string, unknown>
): Array<{ year: string; text: string }> {
  const parsed = parseHistoryTodayData(data);
  if (!parsed) return [];
  return parsed.items.map((item) => ({ year: item.year, text: item.display }));
}

export function monthCellSubtitle(dayData: unknown): string {
  if (!isRecord(dayData)) return '';
  const term = pickText(dayData.solar_term, '');
  if (term) return limitChars(term, 3);
  const festival = traditionalFestivalShortName(pickText(dayData.festival, ''));
  if (festival) return festival;
  return simplifyLunar(pickText(dayData.lunar_date, pickText(dayData.lunar, '')));
}

function simplifyLunar(value: string): string {
  const cleaned = value
    .replace(/^农历/, '')
    .replace(/^[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥]+年\s*/, '');
  const m = cleaned.match(/^(闰?[正一二三四五六七八九十冬腊]+)月(.+)$/);
  if (!m) return limitChars(cleaned, 3);
  const month = m[1]!;
  const day = m[2]!;
  return day === '初一' ? `${month}月` : day;
}
