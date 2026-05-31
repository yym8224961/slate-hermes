import { describe, expect, it } from 'bun:test';
import type { FastifyReply } from 'fastify';
import { etagMatches, respondJsonWithEtag } from './etag';

describe('etagMatches', () => {
  it('matches quoted, weak, bare, and wildcard ETags', () => {
    expect(etagMatches('"abc"', 'abc')).toBe(true);
    expect(etagMatches('W/"abc"', 'abc')).toBe(true);
    expect(etagMatches('abc', 'abc')).toBe(true);
    expect(etagMatches('*', 'abc')).toBe(true);
  });

  it('ignores malformed tags instead of stripping them into matches', () => {
    expect(etagMatches('W/abc', 'abc')).toBe(false);
    expect(etagMatches('"abc', 'abc')).toBe(false);
    expect(etagMatches('abc"', 'abc')).toBe(false);
  });
});

describe('respondJsonWithEtag', () => {
  it('returns 304 when If-None-Match matches', () => {
    const reply = createReply();
    respondJsonWithEtag(
      { headers: { 'if-none-match': '"etag-1"' } } as never,
      reply as never,
      'etag-1',
      { ok: true }
    );

    expect(reply.statusCode).toBe(304);
    expect(reply.headers.ETag).toBe('"etag-1"');
    expect(reply.sent).toBeUndefined();
  });

  it('returns JSON when the ETag does not match', () => {
    const reply = createReply();
    const body = { ok: true };
    respondJsonWithEtag(
      { headers: { 'if-none-match': '"other"' } } as never,
      reply as never,
      'etag-1',
      body
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(reply.sent).toEqual(body);
  });
});

function createReply(): {
  statusCode: number | undefined;
  headers: Record<string, string>;
  sent: unknown;
  status: (code: number) => FastifyReply;
  header: (name: string, value: string) => FastifyReply;
  send: (body?: unknown) => FastifyReply;
} & FastifyReply {
  const reply = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, string>,
    sent: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this as FastifyReply;
    },
    header(name: string, value: string) {
      this.headers[name] = value;
      return this as FastifyReply;
    },
    send(body?: unknown) {
      this.sent = body;
      return this as FastifyReply;
    },
  };
  return reply as typeof reply & FastifyReply;
}
