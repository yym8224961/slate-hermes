import type { Prisma } from '@prisma/client';
import { cnMonthDay, timezoneFromConfig } from './timezone';
import { parseHistoryTodayData } from './history-today.data';
import { refreshIntervalSec } from './dynamic-refresh-policy';

type DynamicDataReusePolicy = 'timestamp' | 'always' | 'never' | 'same_history_today';

export function canReuseDynamicData(
  dynamicType: string,
  dynamicData: Prisma.JsonValue | null,
  imageSize: number,
  config: unknown,
  now: Date,
  lastRunAt?: Date | null
): boolean {
  if (!dynamicData || imageSize === 0) return false;
  const policy = DYNAMIC_DATA_REUSE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_DATA_REUSE_POLICY;
  if (policy.reuse === 'always') return true;
  if (policy.reuse === 'never') return false;
  if (policy.reuse === 'same_history_today') {
    return isSameHistoryTodayData(dynamicData, config, now);
  }
  const lastFreshAt = timestampFromDynamicData(dynamicData) ?? lastRunAt?.getTime() ?? null;
  if (lastFreshAt === null || !Number.isFinite(lastFreshAt)) return false;
  return now.getTime() - lastFreshAt <= maxReusableDynamicDataAgeMs(dynamicType, config);
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
  const policy = DYNAMIC_DATA_REUSE_POLICIES[dynamicType] ?? DEFAULT_DYNAMIC_DATA_REUSE_POLICY;
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

interface DynamicDataReusePolicyConfig {
  reuse: DynamicDataReusePolicy;
  reuseCapSec: number;
}

const DEFAULT_DYNAMIC_DATA_REUSE_POLICY: DynamicDataReusePolicyConfig = {
  reuse: 'timestamp',
  reuseCapSec: 1_800,
};

const DYNAMIC_DATA_REUSE_POLICIES: Record<string, DynamicDataReusePolicyConfig> = {
  daily_calendar: { reuse: 'never', reuseCapSec: 1_800 },
  month_calendar: { reuse: 'never', reuseCapSec: 1_800 },
  history_today: { reuse: 'same_history_today', reuseCapSec: 1_800 },
  weather: { reuse: 'timestamp', reuseCapSec: 43_200 },
  hot_list: { reuse: 'timestamp', reuseCapSec: 3_600 },
  weather_alert: { reuse: 'timestamp', reuseCapSec: 3_600 },
  earthquake_report: { reuse: 'timestamp', reuseCapSec: 3_600 },
  dashboard: { reuse: 'always', reuseCapSec: 1_800 },
  font_test: { reuse: 'always', reuseCapSec: 1_800 },
};
