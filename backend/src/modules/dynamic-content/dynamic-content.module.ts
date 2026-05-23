import { Module } from '@nestjs/common';
import { BlobModule } from '../../infra/blob/blob.module';
import { ImageRendererModule } from '../image-renderer/image-renderer.module';
import { GroupsModule } from '../groups/groups.module';
import { AiModule } from '../ai/ai.module';
import { TtsModule } from '../tts/tts.module';
import { DynamicFrameRendererService } from '../frame-renderer/dynamic-frame-renderer.service';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DailyCalendarProvider } from './providers/daily-calendar.provider';
import { MonthCalendarProvider } from './providers/month-calendar.provider';
import { WeatherProvider } from './providers/weather.provider';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import { FontTestProvider } from './providers/font-test.provider';
import { HotListProvider } from './providers/hot-list.provider';
import { CalendarDataService } from './calendar-data.service';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { DynamicContentSchedulerService } from './dynamic-content-scheduler.service';
import { DynamicAudioService } from './audio/dynamic-audio.service';

/**
 * 动态内容模板与渲染业务模块。
 *
 * 不挂 controller —— 创建/修改/删除走 contents module；data push / refresh 也挂在 contents controller。
 *
 * 暴露 DynamicContentRegistry 与 DynamicContentRendererService 给 contents module 使用。
 */
@Module({
  imports: [BlobModule, ImageRendererModule, GroupsModule, AiModule, TtsModule],
  providers: [
    DynamicContentRegistry,
    CalendarDataService,
    DynamicFrameRendererService,
    DynamicContentRendererService,
    DailyCalendarProvider,
    MonthCalendarProvider,
    WeatherProvider,
    HistoryTodayProvider,
    DashboardProvider,
    FontTestProvider,
    HotListProvider,
    DynamicAudioService,
    DynamicContentSchedulerService,
  ],
  exports: [DynamicContentRegistry, DynamicContentRendererService, CalendarDataService],
})
export class DynamicContentModule {}
