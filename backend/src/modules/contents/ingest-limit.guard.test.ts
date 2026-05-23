import { describe, expect, it } from 'bun:test';
import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { IngestLimitGuard } from './ingest-limit.guard';

function createContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('IngestLimitGuard', () => {
  it('allows up to MAX_PER_WINDOW requests then 429s the next one', () => {
    const guard = new IngestLimitGuard();
    const req = { params: { contentId: 'content-1' }, headers: {} };

    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(createContext(req))).toBe(true);
    }
    try {
      guard.canActivate(createContext(req));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('rejects oversized bodies with 413 before counting them', () => {
    const guard = new IngestLimitGuard();
    const req = {
      params: { contentId: 'content-2' },
      headers: { 'content-length': String(64 * 1024 + 1) },
    };

    try {
      guard.canActivate(createContext(req));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    }
  });

  it('isolates rate-limit buckets per contentId', () => {
    const guard = new IngestLimitGuard();
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
