import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { AppError, RateLimitedError } from '../../../common/errors';
import { IngestPayloadSizeGuard } from './ingest-payload-size.guard';
import { assertIngestPayloadSize } from './ingest-payload-size.pipe';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard';

function createContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('IngestRateLimitGuard', () => {
  it('allows up to MAX_PER_WINDOW requests then 429s the next one', () => {
    const guard = new IngestRateLimitGuard();
    const req = { params: { contentId: 'content-1' }, headers: {} };

    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(createContext(req))).toBe(true);
    }
    try {
      guard.canActivate(createContext(req));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const detail = (err as RateLimitedError).detail as { retry_after_sec?: number };
      expect(typeof detail.retry_after_sec).toBe('number');
      expect(detail.retry_after_sec).toBeGreaterThan(0);
      expect(detail.retry_after_sec).toBeLessThanOrEqual(60);
    }
  });

  it('rejects oversized bodies with 413 before counting them', () => {
    const guard = new IngestPayloadSizeGuard();
    const req = {
      params: { contentId: 'content-2' },
      headers: { 'content-length': String(64 * 1024 + 1) },
    };

    try {
      guard.canActivate(createContext(req));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('payload_too_large');
      expect((err as AppError).httpStatus).toBe(413);
    }
  });

  it('rejects oversized parsed chunked-style payloads', () => {
    const body = { version: 1, data: { value: 'x'.repeat(64 * 1024 + 1) } };

    try {
      assertIngestPayloadSize(body);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('payload_too_large');
      expect((err as AppError).httpStatus).toBe(413);
    }
  });

  it('isolates rate-limit buckets per contentId', () => {
    const guard = new IngestRateLimitGuard();
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(createContext({ params: { contentId: 'a' }, headers: {} }))).toBe(
        true
      );
    }
    // Different contentId should still pass — independent bucket.
    expect(guard.canActivate(createContext({ params: { contentId: 'b' }, headers: {} }))).toBe(
      true
    );
  });
});
