import type { ContentKind, Prisma } from '@prisma/client';
import { FONT_TEST_FONTS } from 'shared';
import { recordValue, valueText } from '../../common/utils';
import { cnMonthDay, datePartsInTz, timezoneFromConfig } from '../dynamic-content/timezone';

export interface ContentStatusBarSource {
  kind: ContentKind;
  frameName: string | null;
  dynamicType: string | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  renderedAt?: Date | null;
}

export function deviceStatusBarText(row: ContentStatusBarSource): string {
  if (row.kind !== 'dynamic') return row.frameName ?? '';
  // 依赖 renderedAt 的动态类型在首次渲染前用 frameName 占位。
  // 不用 `new Date()` 兜底：会让 etag 计算路径在每次刷新时漂移，下游 manifest etag
  // 持续抖动到首次渲染落库，把 304 缓存优势打掉。
  switch (row.dynamicType) {
    case 'daily_calendar':
      if (!row.renderedAt) return row.frameName ?? '';
      return dailyCalendarStatusBarText(row.dynamicData, row.dynamicConfig, row.renderedAt);
    case 'month_calendar':
      if (!row.renderedAt) return row.frameName ?? '';
      return monthCalendarStatusBarText(row.dynamicConfig, row.renderedAt);
    case 'history_today':
      if (!row.renderedAt) return row.frameName ?? '';
      return historyTodayStatusBarText(row.dynamicData, row.dynamicConfig, row.renderedAt);
    case 'weather':
      return weatherStatusBarText(row.dynamicConfig);
    case 'dashboard':
      return row.frameName ?? '数据看板';
    case 'font_test':
      return fontTestStatusBarText(row.dynamicConfig);
    default:
      return row.frameName ?? '';
  }
}

function dailyCalendarStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const parts = datePartsInTz(renderedAt, timezoneFromConfig(config));
  const month = valueText(recordValue(data, 'month')) ?? String(parts.month);
  const day = valueText(recordValue(data, 'day')) ?? String(parts.day);
  return `${Number(month)}月${Number(day)}日`;
}

function monthCalendarStatusBarText(
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const parts = datePartsInTz(renderedAt, timezoneFromConfig(config));
  return `${parts.year}年${parts.month}月`;
}

function historyTodayStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined,
  renderedAt: Date
): string {
  const label =
    valueText(recordValue(data, 'dateLabel')) ?? cnMonthDay(renderedAt, timezoneFromConfig(config));
  return `历史上的${label.replace(/\s+/g, '')}`;
}

export function weatherStatusBarText(config: unknown): string {
  const location = valueText(recordValue(config, 'location_label')) ?? '天气';
  return location === '天气' ? '天气' : `${location}天气`;
}

export function fontTestStatusBarText(config: unknown): string {
  const id = valueText(recordValue(config, 'font_id'));
  return id ? (FONT_TEST_FONTS.find((font) => font.id === id)?.label ?? '字体测试') : '字体测试';
}
