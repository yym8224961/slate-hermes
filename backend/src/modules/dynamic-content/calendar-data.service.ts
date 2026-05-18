import { Injectable } from '@nestjs/common';
import { Solar } from 'lunar-typescript';
import { pickTraditionalFestival } from './traditional-festivals';
import { datePartsInTz, utcOffsetMin } from './timezone';

export interface CalendarDayData {
  lunar: string;
  lunar_date: string;
  ganzhi_year: string;
  ganzhi_month: string;
  ganzhi_day: string;
  solar_term: string | null;
  next_solar_term: string | null;
  next_solar_term_days: number | null;
  festival: string | null;
  yi: string[];
  ji: string[];
  is_workday: boolean;
}

export interface CalendarServerData {
  calendar: {
    timezone: string;
    utc_offset_min: number;
    coverage: { from: string; to: string };
    months: Record<string, { days: Record<string, CalendarDayData> }>;
  };
}

@Injectable()
export class CalendarDataService {
  buildCurrentAndNextMonth(now: Date, tz: string): CalendarServerData {
    const cur = datePartsInTz(now, tz);
    const next =
      cur.month === 12
        ? { year: cur.year + 1, month: 1 }
        : { year: cur.year, month: cur.month + 1 };
    const months: Record<string, { days: Record<string, CalendarDayData> }> = {};
    months[monthKey(cur.year, cur.month)] = { days: this.buildMonth(cur.year, cur.month) };
    months[monthKey(next.year, next.month)] = { days: this.buildMonth(next.year, next.month) };

    const from = `${monthKey(cur.year, cur.month)}-01`;
    const to = `${monthKey(next.year, next.month)}-${String(daysInMonth(next.year, next.month)).padStart(2, '0')}`;
    return {
      calendar: {
        timezone: tz,
        utc_offset_min: utcOffsetMin(now, tz),
        coverage: { from, to },
        months,
      },
    };
  }

  private buildMonth(year: number, month: number): Record<string, CalendarDayData> {
    const days: Record<string, CalendarDayData> = {};
    const total = daysInMonth(year, month);
    for (let day = 1; day <= total; day++) {
      const key = `${monthKey(year, month)}-${String(day).padStart(2, '0')}`;
      const solar = Solar.fromYmd(year, month, day);
      const lunar = solar.getLunar();
      const jieQi = lunar.getJieQi();
      const jieQiDate = jieQi ? lunar.getJieQiTable()[jieQi] : null;
      const isTerm =
        !!jieQiDate &&
        jieQiDate.getYear() === year &&
        jieQiDate.getMonth() === month &&
        jieQiDate.getDay() === day;
      const nextTerm = isTerm
        ? { name: jieQi, days: 0 }
        : findNextSolarTerm(lunar, year, month, day);
      const festivals = [
        ...lunar.getFestivals(),
        ...lunar.getOtherFestivals(),
        ...solar.getFestivals(),
        ...solar.getOtherFestivals(),
      ].filter(Boolean);
      const traditionalFestival = pickTraditionalFestival(festivals);
      const ganzhiYear = `${lunar.getYearInGanZhiExact()}年`;
      const lunarDate = `农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
      days[key] = {
        lunar: `${ganzhiYear} ${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
        lunar_date: lunarDate,
        ganzhi_year: ganzhiYear,
        ganzhi_month: `${lunar.getMonthInGanZhiExact()}月`,
        ganzhi_day: `${lunar.getDayInGanZhiExact()}日`,
        solar_term: isTerm ? jieQi : null,
        next_solar_term: nextTerm?.name ?? null,
        next_solar_term_days: nextTerm?.days ?? null,
        festival: traditionalFestival,
        yi: lunar.getDayYi().slice(0, 5),
        ji: lunar.getDayJi().slice(0, 5),
        is_workday: solar.getWeek() >= 1 && solar.getWeek() <= 5,
      };
    }
    return days;
  }
}

function findNextSolarTerm(
  lunar: ReturnType<ReturnType<typeof Solar.fromYmd>['getLunar']>,
  year: number,
  month: number,
  day: number
): { name: string; days: number } | null {
  const currentKey = year * 10000 + month * 100 + day;
  const currentTime = Date.UTC(year, month - 1, day);
  const items = Object.entries(lunar.getJieQiTable())
    .map(([name, solar]) => ({
      name,
      key: solar.getYear() * 10000 + solar.getMonth() * 100 + solar.getDay(),
      days: Math.max(
        0,
        Math.round(
          (Date.UTC(solar.getYear(), solar.getMonth() - 1, solar.getDay()) - currentTime) /
            86_400_000
        )
      ),
    }))
    .filter((item) => item.key >= currentKey)
    .sort((a, b) => a.key - b.key);
  const next = items[0];
  return next ? { name: next.name, days: next.days } : null;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
