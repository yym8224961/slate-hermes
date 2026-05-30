import { Module } from '@nestjs/common';
import { BlobModule } from '../../infra/blob/blob.module';
import { GroupsModule } from '../groups/groups.module';
import { AiModule } from '../ai/ai.module';
import { TtsModule } from '../tts/tts.module';
import { HotListModule } from '../hot-list/hot-list.module';
import { DynamicFrameRendererService } from './rendering/dynamic-frame-renderer.service';
import { DynamicFrameFontService } from './rendering/dynamic-frame-font.service';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DailyCalendarProvider } from './providers/daily-calendar.provider';
import { MonthCalendarProvider } from './providers/month-calendar.provider';
import { WeatherProvider } from './providers/weather.provider';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { WeatherAlertProvider } from './providers/weather-alert.provider';
import { EarthquakeReportProvider } from './providers/earthquake-report.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import { FontTestProvider } from './providers/font-test.provider';
import { CalendarDataService } from './calendar-data.service';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { DynamicContentService } from './dynamic-content.service';
import { DynamicContentSchedulerService } from './dynamic-content-scheduler.service';
import { DynamicAudioService } from './audio/dynamic-audio.service';
import { WeatherCityController } from './weather-city.controller';
import { WeatherCitySearchRateLimitGuard } from './weather-city-search-rate-limit.guard';

/**
 * 动态内容模板与渲染业务模块。
 *
 * 创建/修改/预览/data push / refresh 的动态内容生命周期由 DynamicContentService 承担；
 * contents module 只负责把通用内容 API 转发进来。
 *
 * 暴露 DynamicContentRegistry、DynamicContentRendererService 与 DynamicContentService 给 contents module 使用。
 */
@Module({
  imports: [BlobModule, GroupsModule, AiModule, TtsModule, HotListModule],
  controllers: [WeatherCityController],
  providers: [
    DynamicContentRegistry,
    CalendarDataService,
    DynamicFrameFontService,
    DynamicFrameRendererService,
    DynamicContentRendererService,
    DynamicContentService,
    DailyCalendarProvider,
    MonthCalendarProvider,
    WeatherProvider,
    HistoryTodayProvider,
    WeatherAlertProvider,
    EarthquakeReportProvider,
    DashboardProvider,
    FontTestProvider,
    DynamicAudioService,
    DynamicContentSchedulerService,
    WeatherCitySearchRateLimitGuard,
  ],
  exports: [
    DynamicContentRegistry,
    DynamicContentRendererService,
    DynamicContentService,
    CalendarDataService,
  ],
})
export class DynamicContentModule {}
