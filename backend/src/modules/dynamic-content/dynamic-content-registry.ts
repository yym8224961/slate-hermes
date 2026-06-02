import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { DynamicContentEntry } from './dynamic-content.types';
import type { Block, DynamicContentDefinition } from './layout-engine/types';
import { DailyCalendarProvider } from './providers/daily-calendar.provider';
import { MonthCalendarProvider } from './providers/month-calendar.provider';
import { WeatherProvider } from './providers/weather.provider';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { WeatherAlertProvider } from './providers/weather-alert.provider';
import { EarthquakeReportProvider } from './providers/earthquake-report.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import { FontTestProvider } from './providers/font-test.provider';
import { HotListProvider } from '../hot-list/hot-list.provider';
import dailyCalendarDefinition from './definitions/daily-calendar.json' with { type: 'json' };
import monthCalendarDefinition from './definitions/month-calendar.json' with { type: 'json' };
import weatherDefinition from './definitions/weather.json' with { type: 'json' };
import historyTodayDefinition from './definitions/history-today.json' with { type: 'json' };
import weatherAlertDefinition from './definitions/weather-alert.json' with { type: 'json' };
import earthquakeReportDefinition from './definitions/earthquake-report.json' with { type: 'json' };
import dashboardDefinition from './definitions/dashboard.json' with { type: 'json' };
import fontTestDefinition from './definitions/font-test.json' with { type: 'json' };
import hotListDefinition from './definitions/hot-list.json' with { type: 'json' };

/**
 * 中央注册表。启动时把所有 (definition, provider) 对装进 Map。
 * 渲染/调度都从这里取。
 *
 * 新增 动态内容类型 = 新增 providers/*.provider.ts + definitions/*.json + 在 registerAll() 里 register 一次。
 */
@Injectable()
export class DynamicContentRegistry implements OnModuleInit {
  private readonly logger = new Logger(DynamicContentRegistry.name);
  private readonly entries = new Map<string, DynamicContentEntry>();

  constructor(
    private readonly dailyCalendarProvider: DailyCalendarProvider,
    private readonly monthCalendarProvider: MonthCalendarProvider,
    private readonly weatherProvider: WeatherProvider,
    private readonly historyTodayProvider: HistoryTodayProvider,
    private readonly weatherAlertProvider: WeatherAlertProvider,
    private readonly earthquakeReportProvider: EarthquakeReportProvider,
    private readonly dashboardProvider: DashboardProvider,
    private readonly fontTestProvider: FontTestProvider,
    private readonly hotListProvider: HotListProvider
  ) {}

  onModuleInit(): void {
    this.registerAll();
    this.logger.log(`Loaded dynamic content types: ${[...this.entries.keys()].join(', ')}.`);
  }

  private registerAll(): void {
    this.register(normalizeDefinition(dailyCalendarDefinition), this.dailyCalendarProvider);
    this.register(normalizeDefinition(monthCalendarDefinition), this.monthCalendarProvider);
    this.register(normalizeDefinition(weatherDefinition), this.weatherProvider);
    this.register(normalizeDefinition(historyTodayDefinition), this.historyTodayProvider);
    this.register(normalizeDefinition(weatherAlertDefinition), this.weatherAlertProvider);
    this.register(normalizeDefinition(earthquakeReportDefinition), this.earthquakeReportProvider);
    this.register(normalizeDefinition(dashboardDefinition), this.dashboardProvider);
    this.register(normalizeDefinition(fontTestDefinition), this.fontTestProvider);
    this.register(normalizeDefinition(hotListDefinition), this.hotListProvider);
  }

  private register(def: DynamicContentDefinition, provider: DynamicContentEntry['provider']): void {
    if (def.type !== provider.type) {
      throw new Error(
        `动态内容注册不一致：definition.type=${def.type} provider.type=${provider.type}`
      );
    }
    if (this.entries.has(def.type)) {
      throw new Error(`动态内容类型重复注册: ${def.type}`);
    }
    this.entries.set(def.type, { type: def.type, definition: def, provider });
  }

  get(type: string): DynamicContentEntry | undefined {
    return this.entries.get(type);
  }

  defaultTtlSec(type: string): number | null {
    return this.entries.get(type)?.definition.default_ttl_sec ?? null;
  }
}

const FontFamilySchema = z.enum(['serif', 'sans', 'mono']);
const TextAlignSchema = z.enum(['left', 'center', 'right']);
const WeightSchema = z.enum(['normal', 'bold']);

const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion('block', [
    z.object({
      block: z.literal('centered_text'),
      field: z.string(),
      size: z.number(),
      font: FontFamilySchema.optional(),
      weight: WeightSchema.optional(),
    }),
    z.object({
      block: z.literal('text'),
      field: z.string(),
      size: z.number(),
      font: FontFamilySchema.optional(),
      align: TextAlignSchema.optional(),
      wrap: z.boolean().optional(),
      max_lines: z.number().optional(),
      weight: WeightSchema.optional(),
    }),
    z.object({
      block: z.literal('key_value'),
      items: z.array(
        z.object({
          label: z.string().optional(),
          label_field: z.string().optional(),
          field: z.string(),
          suffix: z.string().optional(),
        })
      ),
      size: z.number().optional(),
      font: FontFamilySchema.optional(),
    }),
    z.object({
      block: z.literal('big_number'),
      field: z.string(),
      size: z.number(),
      suffix: z.string().optional(),
      align: TextAlignSchema.optional(),
      font: FontFamilySchema.optional(),
    }),
    z.object({
      block: z.literal('separator'),
      style: z.enum(['solid', 'dashed']).optional(),
    }),
    z.object({
      block: z.literal('vertical_stack'),
      body: z.array(BlockSchema),
      gap: z.number().optional(),
    }),
  ])
);

const DynamicContentDefinitionSchema: z.ZodType<DynamicContentDefinition> = z.object({
  type: z.string(),
  default_ttl_sec: z.number().nullable(),
  layout: z.object({
    size: z.tuple([z.number(), z.number()]),
    padding: z.number().optional(),
    top_offset: z.number().optional(),
    body: z.array(BlockSchema),
  }),
});

function normalizeDefinition(def: unknown): DynamicContentDefinition {
  return DynamicContentDefinitionSchema.parse(def);
}
