import { nextLocalMidnight, timezoneFromConfig } from './timezone';

const REFRESH_LEAD_MS = 90_000;
const MIN_REFRESH_DUE_DELAY_MS = 10_000;
const CALENDAR_WAKE_LAG_MS = 60_000;

export type DynamicSchedulePolicy = 'calendar' | 'refresh_interval' | 'registry_ttl';

export interface DynamicRefreshSchedule {
  nextRunAt: Date | null;
  refreshDueAt: Date | null;
}

export function dynamicSchedulePolicy(dynamicType: string): DynamicSchedulePolicy {
  return DYNAMIC_SCHEDULE_POLICIES[dynamicType] ?? 'registry_ttl';
}

export function refreshIntervalSec(config: unknown): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const raw = record.refresh_interval_sec;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const min = record.type === 'dashboard' ? 60 : 300;
  return Math.max(Math.floor(raw), min);
}

export function computeDynamicRefreshSchedule(input: {
  dynamicType: string;
  config: unknown;
  now: Date;
  defaultTtlSec: number | null;
}): DynamicRefreshSchedule {
  const nextRunAt = computeNextRunAt(input);
  return {
    nextRunAt,
    refreshDueAt: computeRefreshDueAt(input.dynamicType, nextRunAt, input.now),
  };
}

function computeNextRunAt(input: {
  dynamicType: string;
  config: unknown;
  now: Date;
  defaultTtlSec: number | null;
}): Date | null {
  const policy = dynamicSchedulePolicy(input.dynamicType);
  if (policy === 'refresh_interval') {
    const configured = refreshIntervalSec(input.config);
    if (configured !== null) return new Date(input.now.getTime() + configured * 1000);
  }
  if (policy === 'calendar') {
    const midnight = nextLocalMidnight(input.now, timezoneFromConfig(input.config));
    return new Date(midnight.getTime() + CALENDAR_WAKE_LAG_MS);
  }
  if (input.defaultTtlSec === null) return null;
  return new Date(input.now.getTime() + input.defaultTtlSec * 1000);
}

function computeRefreshDueAt(dynamicType: string, nextRunAt: Date | null, now: Date): Date | null {
  if (!nextRunAt) return null;
  const policy = dynamicSchedulePolicy(dynamicType);
  if (policy === 'calendar') {
    const dueMs = nextRunAt.getTime() - CALENDAR_WAKE_LAG_MS;
    if (dueMs <= now.getTime()) return new Date(now.getTime() + MIN_REFRESH_DUE_DELAY_MS);
    return new Date(dueMs);
  }
  if (policy === 'refresh_interval') return nextRunAt;
  const dueMs = nextRunAt.getTime() - REFRESH_LEAD_MS;
  if (dueMs <= now.getTime()) return new Date(now.getTime() + MIN_REFRESH_DUE_DELAY_MS);
  return new Date(dueMs);
}

const DYNAMIC_SCHEDULE_POLICIES: Record<string, DynamicSchedulePolicy> = {
  daily_calendar: 'calendar',
  month_calendar: 'calendar',
  history_today: 'calendar',
  weather: 'refresh_interval',
  hot_list: 'refresh_interval',
  weather_alert: 'refresh_interval',
  earthquake_report: 'refresh_interval',
  dashboard: 'refresh_interval',
  font_test: 'registry_ttl',
};
