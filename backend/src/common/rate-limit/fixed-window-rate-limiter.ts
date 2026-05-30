import { evictOldestMapEntry, setBoundedCache } from '../utils/cache-utils';

interface Bucket {
  windowStartMs: number;
  count: number;
  lastSeenMs: number;
}

export interface FixedWindowRateLimiterOptions {
  windowMs: number;
  maxBuckets: number;
  staleBucketMs?: number;
  cleanupBatchSize?: number;
}

export type RateLimitHitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly staleBucketMs: number;
  private readonly cleanupBatchSize: number;
  private lastCleanupMs = 0;
  private cleanupCursor: string | null = null;

  constructor(private readonly opts: FixedWindowRateLimiterOptions) {
    this.staleBucketMs = opts.staleBucketMs ?? opts.windowMs * 2;
    this.cleanupBatchSize = opts.cleanupBatchSize ?? 256;
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
      setBoundedCache(this.buckets, key, bucket, this.opts.maxBuckets);
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
    if (this.buckets.size === 0) {
      this.cleanupCursor = null;
      return;
    }
    let checked = this.cleanupFromCursor(now);
    if (checked < this.cleanupBatchSize) checked += this.cleanupFromStart(now, checked);
    if (checked < this.cleanupBatchSize) this.cleanupCursor = null;
  }

  private cleanupFromCursor(now: number): number {
    if (this.cleanupCursor === null) return 0;
    return this.cleanupRange(now, this.cleanupCursor, this.cleanupBatchSize);
  }

  private cleanupFromStart(now: number, alreadyChecked: number): number {
    const remaining = this.cleanupBatchSize - alreadyChecked;
    const first = this.buckets.keys().next().value as string | undefined;
    if (first === undefined || remaining <= 0) return 0;
    return this.cleanupRange(now, first, remaining);
  }

  private cleanupRange(now: number, firstKey: string, limit: number): number {
    let checked = 0;
    let started = false;
    const iterator = this.buckets[Symbol.iterator]();
    while (true) {
      const next = iterator.next();
      if (next.done) {
        this.cleanupCursor = null;
        return checked;
      }
      const [key, bucket] = next.value;
      if (!started) {
        if (key !== firstKey) continue;
        started = true;
      }
      checked += 1;
      if (now - bucket.lastSeenMs >= this.staleBucketMs) this.buckets.delete(key);
      if (checked >= limit) {
        const cursor = iterator.next();
        this.cleanupCursor = cursor.done ? null : cursor.value[0];
        return checked;
      }
    }
  }

  private touch(key: string, bucket: Bucket): void {
    setBoundedCache(this.buckets, key, bucket, this.opts.maxBuckets);
  }

  private evictOldest(): void {
    evictOldestMapEntry(this.buckets);
  }
}
