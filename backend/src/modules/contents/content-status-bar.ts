import type { ContentKind, Prisma } from '@prisma/client';
import { FONT_TEST_FONTS } from 'shared';
import { datePartsInTz, timezoneFromConfig } from '../dynamic-content/timezone';

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
  const renderedAt = row.renderedAt ?? new Date();
  switch (row.dynamicType) {
    case 'daily_calendar':
      return dailyCalendarStatusBarText(row.dynamicData, row.dynamicConfig, renderedAt);
    case 'month_calendar':
      return monthCalendarStatusBarText(row.dynamicConfig, renderedAt);
    case 'history_today':
      return historyTodayStatusBarText(row.dynamicData, row.dynamicConfig, renderedAt);
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

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function valueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function cnMonthDay(date: Date, timeZone: string): string {
  const parts = datePartsInTz(date, timeZone);
  return `${parts.month}月${parts.day}日`;
}
