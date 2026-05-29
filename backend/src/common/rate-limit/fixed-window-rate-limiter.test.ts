import { describe, expect, it } from 'bun:test';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter';

describe('FixedWindowRateLimiter', () => {
  it('cleans stale buckets incrementally', () => {
    const limiter = new FixedWindowRateLimiter({
      windowMs: 100,
      staleBucketMs: 100,
      maxBuckets: 10,
      cleanupBatchSize: 2,
    });

    expect(limiter.hit('a', 1, 0).allowed).toBe(true);
    expect(limiter.hit('b', 1, 0).allowed).toBe(true);
    expect(limiter.hit('c', 1, 0).allowed).toBe(true);

    expect(limiter.hit('d', 1, 200).allowed).toBe(true);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(2);

    expect(limiter.hit('e', 1, 300).allowed).toBe(true);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });

  it('does not resume cleanup from a deleted cursor key', () => {
    const limiter = new FixedWindowRateLimiter({
      windowMs: 100,
      staleBucketMs: 100,
      maxBuckets: 20,
      cleanupBatchSize: 2,
    });

    expect(limiter.hit('a', 1, 0).allowed).toBe(true);
    expect(limiter.hit('b', 1, 0).allowed).toBe(true);
    expect(limiter.hit('c', 1, 0).allowed).toBe(true);
    expect(limiter.hit('d', 1, 90).allowed).toBe(true);

    expect(limiter.hit('e', 1, 100).allowed).toBe(true);
    expect((limiter as unknown as { cleanupCursor: string | null }).cleanupCursor).toBe('c');
    expect([...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()]).toEqual([
      'c',
      'd',
      'e',
    ]);

    expect(limiter.hit('f', 1, 200).allowed).toBe(true);
    expect([...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()]).toEqual([
      'e',
      'f',
    ]);
  });
});
