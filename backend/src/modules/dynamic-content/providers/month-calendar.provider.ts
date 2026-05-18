import { Injectable } from '@nestjs/common';
import { MonthCalendarConfig, type MonthCalendarConfigT } from 'shared';
import type { CalendarServerData } from '../calendar-data.service';
import { CalendarDataService } from '../calendar-data.service';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';

@Injectable()
export class MonthCalendarProvider implements DataProvider<
  MonthCalendarConfigT,
  CalendarServerData
> {
  readonly type = 'month_calendar';

  constructor(private readonly calendar: CalendarDataService) {}

  validateConfig(raw: unknown): MonthCalendarConfigT {
    return MonthCalendarConfig.parse(raw);
  }

  fetchData(
    config: MonthCalendarConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<CalendarServerData> {
    return Promise.resolve(this.calendar.buildCurrentAndNextMonth(ctx.now, config.tz));
  }
}
