import type { FixedWindowRateLimiterOptions } from './fixed-window-rate-limiter';
import type { RateLimitGuardOptions } from './rate-limit-guard';

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 10_000;

export interface RateLimitDefaults {
  windowMs?: number;
  maxBuckets?: number;
  staleBucketMs?: number;
  cleanupBatchSize?: number;
}

export type RateLimitConfig = Omit<RateLimitGuardOptions, 'limiter'> & {
  limiter?: Partial<FixedWindowRateLimiterOptions>;
};

export function createRateLimit(
  defaults: RateLimitDefaults,
  config: RateLimitConfig
): RateLimitGuardOptions {
  const windowMs = defaults.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxBuckets = defaults.maxBuckets ?? DEFAULT_RATE_LIMIT_MAX_BUCKETS;
  const staleBucketMs = defaults.staleBucketMs ?? windowMs * 2;

  return {
    ...config,
    limiter: {
      windowMs,
      maxBuckets,
      staleBucketMs,
      cleanupBatchSize: defaults.cleanupBatchSize,
      ...config.limiter,
    },
  };
}
