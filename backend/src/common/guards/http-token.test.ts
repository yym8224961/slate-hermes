import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { extractCookieToken } from './http-token';

describe('http-token', () => {
  it('rejects oversized cookie tokens', () => {
    const req = {
      headers: { cookie: `auth_token=${'x'.repeat(4097)}` },
    } as unknown as FastifyRequest;

    expect(extractCookieToken(req)).toBe(null);
  });
});
