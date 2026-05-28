interface Bucket {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
}

export interface FixedWindowRateLimiterOptions {
  windowMs: number;
  maxBuckets: number;
  staleBucketMs?: number;
}

export type RateLimitHitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly staleBucketMs: number;
  private lastCleanupMs = 0;

  constructor(private readonly opts: FixedWindowRateLimiterOptions) {
    this.staleBucketMs = opts.staleBucketMs ?? opts.windowMs * 2;
  }

  hit(key: string, maxPerWindow: number, now: number = Date.now()): RateLimitHitResult {
    this.cleanup(now);

    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartMs >= this.opts.windowMs) {
      if (bucket) {
        this.buckets.delete(key);
      } else if (this.buckets.size >= this.opts.maxBuckets) {
        this.evictOldest();
      }
      bucket = { windowStartMs: now, count: 0, lastSeenMs: now };
      this.buckets.set(key, bucket);
    }

    bucket.lastSeenMs = now;
    bucket.count += 1;
    this.touch(key, bucket);

    if (bucket.count <= maxPerWindow) return { allowed: true };
    return {
      allowed: false,
      retryAfterSec: Math.max(
        Math.ceil((this.opts.windowMs - (now - bucket.windowStartMs)) / 1000),
        1
      ),
    };
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanupMs < this.opts.windowMs) return;
    this.lastCleanupMs = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeenMs < this.staleBucketMs) continue;
      this.buckets.delete(key);
    }
  }

  private touch(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private evictOldest(): void {
    const oldestKey = this.buckets.keys().next().value as string | undefined;
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}
