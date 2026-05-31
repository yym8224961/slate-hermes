import { Injectable } from '@nestjs/common';
import { Solar } from 'lunar-typescript';
import { DailyCalendarConfig, type DailyCalendarConfigT } from 'shared';
import { pickTraditionalFestival } from '../traditional-festivals';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { findNextSolarTerm } from '../calendar-data.service';
import { datePartsInTz } from '../timezone';

export interface DailyCalendarProviderData {
  /** 公历：2026 */
  year: string;
  /** 公历月：5 */
  month: string;
  /** 公历日：15 */
  day: string;
  /** 公历月/日，左零：05 / 13 */
  monthDay: string;
  /** 星期，中文：周三 */
  weekdayCN: string;
  /** 农历日期，含闰月：丙午年 三月廿七 / null 表示不显示 */
  lunar: string | null;
  /** 农历日期，不含干支年：农历三月廿七 */
  lunarDate: string | null;
  /** 干支年：丙午年 */
  ganzhiYear: string | null;
  /** 干支月：癸巳月 */
  ganzhiMonth: string | null;
  /** 干支日：己丑日 */
  ganzhiDay: string | null;
  /** 节气名，命中当天才有；否则 null */
  solarTerm: string | null;
  /** 下一个节气，今日命中时与 solarTerm 一致。 */
  nextSolarTerm: string | null;
  /** 距下一个节气的天数；今日命中为 0。 */
  nextSolarTermDays: number | null;
  /** 中国传统节日；非传统节日不下发。 */
  festival: string | null;
  yi: string[];
  ji: string[];
}

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

@Injectable()
export class DailyCalendarProvider implements DataProvider<
  DailyCalendarConfigT,
  DailyCalendarProviderData
> {
  readonly type = 'daily_calendar';

  validateConfig(raw: unknown): DailyCalendarConfigT {
    return DailyCalendarConfig.parse(raw);
  }

  fetchData(
    config: DailyCalendarConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<DailyCalendarProviderData> {
    return Promise.resolve(this.computeData(config, ctx));
  }

  private computeData(
    config: DailyCalendarConfigT,
    ctx: DynamicContentFetchCtx
  ): DailyCalendarProviderData {
    const { year, month, day, weekday } = datePartsInTz(ctx.now, config.tz);
    const solar = Solar.fromYmd(year, month, day);
    const lunar = solar.getLunar();

    const ganzhiYear = `${lunar.getYearInGanZhiExact()}年`;
    const ganzhiMonth = `${lunar.getMonthInGanZhiExact()}月`;
    const ganzhiDay = `${lunar.getDayInGanZhiExact()}日`;
    const lunarDate = `农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
    const lunarStr = `${ganzhiYear} ${lunarDate.replace(/^农历/, '')}`;
    // 节气：getJieQi() 返回最近节气，需要校验是否就是今日
    const jieQi = lunar.getJieQi(); // 如 "立夏"
    const jieQiDate = jieQi ? lunar.getJieQiTable()[jieQi] : undefined;
    const isToday =
      jieQi &&
      jieQiDate &&
      jieQiDate.getYear() === year &&
      jieQiDate.getMonth() === month &&
      jieQiDate.getDay() === day;

    const nextTerm = isToday
      ? { name: jieQi, days: 0 }
      : findNextSolarTerm(lunar, year, month, day);
    const festivals = [
      ...lunar.getFestivals(),
      ...lunar.getOtherFestivals(),
      ...solar.getFestivals(),
      ...solar.getOtherFestivals(),
    ].filter(Boolean);

    return {
      year: String(year),
      month: String(month),
      day: String(day),
      monthDay: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      weekdayCN: WEEKDAY_CN[weekday]!,
      lunar: lunarStr,
      lunarDate,
      ganzhiYear,
      ganzhiMonth,
      ganzhiDay,
      solarTerm: isToday ? jieQi : null,
      nextSolarTerm: nextTerm?.name ?? null,
      nextSolarTermDays: nextTerm?.days ?? null,
      festival: pickTraditionalFestival(festivals),
      yi: lunar.getDayYi().slice(0, 5),
      ji: lunar.getDayJi().slice(0, 5),
    };
  }
}
