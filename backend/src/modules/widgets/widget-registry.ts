import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { WidgetEntry } from './widget-types';
import type { WidgetDefinition } from './layout-engine/types';
import { DateProvider } from './providers/date.provider';
import { WeatherProvider } from './providers/weather.provider';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import dateDefinition from './definitions/date.json' with { type: 'json' };
import weatherDefinition from './definitions/weather.json' with { type: 'json' };
import historyTodayDefinition from './definitions/history-today.json' with { type: 'json' };
import dashboardDefinition from './definitions/dashboard-metrics.json' with { type: 'json' };

/**
 * 中央注册表。启动时把所有 (definition, provider) 对装进 Map。
 * 渲染/调度都从这里取。
 *
 * 新增 widget 类型 = 新增 providers/*.provider.ts + definitions/*.json + 在 registerAll() 里 register 一次。
 */
@Injectable()
export class WidgetRegistry implements OnModuleInit {
  private readonly logger = new Logger(WidgetRegistry.name);
  private readonly entries = new Map<string, WidgetEntry>();

  constructor(
    private readonly dateProvider: DateProvider,
    private readonly weatherProvider: WeatherProvider,
    private readonly historyTodayProvider: HistoryTodayProvider,
    private readonly dashboardProvider: DashboardProvider
  ) {}

  onModuleInit(): void {
    this.registerAll();
    this.logger.log(`已加载 widget 类型: ${[...this.entries.keys()].join(', ')}`);
  }

  private registerAll(): void {
    this.register(dateDefinition as WidgetDefinition, this.dateProvider);
    this.register(weatherDefinition as WidgetDefinition, this.weatherProvider);
    this.register(historyTodayDefinition as WidgetDefinition, this.historyTodayProvider);
    this.register(dashboardDefinition as WidgetDefinition, this.dashboardProvider);
  }

  private register(def: WidgetDefinition, provider: WidgetEntry['provider']): void {
    if (def.type !== provider.type) {
      throw new Error(
        `widget 注册不一致：definition.type=${def.type} provider.type=${provider.type}`
      );
    }
    if (this.entries.has(def.type)) {
      throw new Error(`widget 类型重复注册: ${def.type}`);
    }
    this.entries.set(def.type, { type: def.type, definition: def, provider });
  }

  get(type: string): WidgetEntry | undefined {
    return this.entries.get(type);
  }

  /** scheduler 启动时用：列出所有 push-only 之外的可调度类型。 */
  schedulableTypes(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.definition.default_ttl_sec !== null)
      .map((e) => e.type);
  }

  /** widget 类型的默认 TTL（秒）。push-only 返回 null。 */
  defaultTtlSec(type: string): number | null {
    return this.entries.get(type)?.definition.default_ttl_sec ?? null;
  }
}
