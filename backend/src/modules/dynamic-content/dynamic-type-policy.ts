import type { Prisma } from '@prisma/client';
import { cnMonthDay, timezoneFromConfig } from './timezone';
import { parseHistoryTodayData } from './history-today.data';

export function canReuseDynamicData(
  dynamicType: string,
  dynamicData: Prisma.JsonValue | null,
  imageSize: number,
  config: unknown,
  now: Date,
  lastRunAt?: Date | null
): boolean {
  if (!dynamicData || imageSize === 0) return false;
  const policy = DYNAMIC_TYPE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_TYPE_POLICY;
  if (policy.reuse === 'always') return true;
  if (policy.reuse === 'never') return false;
  if (policy.reuse === 'same_history_today') {
    return isSameHistoryTodayData(dynamicData, config, now);
  }
  const lastFreshAt = timestampFromDynamicData(dynamicData) ?? lastRunAt?.getTime() ?? null;
  if (lastFreshAt === null || !Number.isFinite(lastFreshAt)) return false;
  return now.getTime() - lastFreshAt <= maxReusableDynamicDataAgeMs(dynamicType, config);
}

export function refreshIntervalSec(config: unknown): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const raw = record.refresh_interval_sec;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const min = record.type === 'dashboard' ? 60 : 300;
  return Math.max(Math.floor(raw), min);
}

export function isCalendarLikeDynamicType(dynamicType: string): boolean {
  return (
    (DYNAMIC_TYPE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_TYPE_POLICY).schedule === 'calendar'
  );
}

export function isRefreshIntervalDynamicType(dynamicType: string): boolean {
  return (
    (DYNAMIC_TYPE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_TYPE_POLICY).schedule ===
    'refresh_interval'
  );
}

function isSameHistoryTodayData(
  dynamicData: Prisma.JsonValue,
  config: unknown,
  now: Date
): boolean {
  const parsed = parseHistoryTodayData(dynamicData);
  if (!parsed) return false;
  const expected = cnMonthDay(now, timezoneFromConfig(config));
  return parsed.dateLabel.replace(/\s+/g, '') === expected;
}

function maxReusableDynamicDataAgeMs(dynamicType: string, config: unknown): number {
  const policy = DYNAMIC_TYPE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_TYPE_POLICY;
  const configured = refreshIntervalSec(config) ?? 600;
  const ageSec = Math.max(configured * 3, 900);
  return Math.min(ageSec, policy.reuseCapSec) * 1000;
}

function timestampFromDynamicData(dynamicData: Prisma.JsonValue): number | null {
  if (!dynamicData || typeof dynamicData !== 'object' || Array.isArray(dynamicData)) return null;
  const value = (dynamicData as Record<string, Prisma.JsonValue>).updatedAt;
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

interface DynamicTypePolicy {
  schedule: 'calendar' | 'refresh_interval' | 'registry_ttl';
  reuse: 'timestamp' | 'always' | 'never' | 'same_history_today';
  reuseCapSec: number;
}

const DEFAULT_DYNAMIC_TYPE_POLICY: DynamicTypePolicy = {
  schedule: 'registry_ttl',
  reuse: 'timestamp',
  reuseCapSec: 1_800,
};

const DYNAMIC_TYPE_POLICIES: Record<string, DynamicTypePolicy> = {
  daily_calendar: { schedule: 'calendar', reuse: 'never', reuseCapSec: 1_800 },
  month_calendar: { schedule: 'calendar', reuse: 'never', reuseCapSec: 1_800 },
  history_today: { schedule: 'calendar', reuse: 'same_history_today', reuseCapSec: 1_800 },
  weather: { schedule: 'registry_ttl', reuse: 'timestamp', reuseCapSec: 43_200 },
  hot_list: { schedule: 'refresh_interval', reuse: 'timestamp', reuseCapSec: 3_600 },
  weather_alert: { schedule: 'refresh_interval', reuse: 'timestamp', reuseCapSec: 3_600 },
  earthquake_report: { schedule: 'refresh_interval', reuse: 'timestamp', reuseCapSec: 3_600 },
  dashboard: { schedule: 'refresh_interval', reuse: 'always', reuseCapSec: 1_800 },
  font_test: { schedule: 'registry_ttl', reuse: 'always', reuseCapSec: 1_800 },
};
