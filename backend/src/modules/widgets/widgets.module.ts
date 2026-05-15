import { Module } from '@nestjs/common';
import { BlobModule } from '../../infra/blob/blob.module';
import { RenderModule } from '../render/render.module';
import { GroupsModule } from '../groups/groups.module';
import { WidgetRegistry } from './widget-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { WidgetSchedulerService } from './widget-scheduler.service';
import { DateProvider } from './providers/date.provider';
import { WeatherProvider } from './providers/weather.provider';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import { DynamicFrameRendererService } from '../device-renderer/dynamic-frame-renderer.service';

/**
 * 动态内容模板与渲染业务模块。
 *
 * 不挂 controller —— 创建/修改/删除走 contents module；data push / refresh 也挂在 contents controller。
 *
 * 仅暴露 DynamicContentRendererService 与 WidgetRegistry 给 contents module 使用。
 */
@Module({
  imports: [BlobModule, RenderModule, GroupsModule],
  providers: [
    WidgetRegistry,
    DynamicFrameRendererService,
    DynamicContentRendererService,
    WidgetSchedulerService,
    DateProvider,
    WeatherProvider,
    HistoryTodayProvider,
    DashboardProvider,
  ],
  exports: [WidgetRegistry, DynamicContentRendererService, DynamicFrameRendererService],
})
export class WidgetsModule {}
