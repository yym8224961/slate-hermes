import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { extractCookieToken, extractDeviceSecret } from './http-token';

describe('http-token', () => {
  it('rejects oversized cookie tokens', () => {
    const req = {
      headers: { cookie: `auth_token=${'x'.repeat(4097)}` },
    } as unknown as FastifyRequest;

    expect(extractCookieToken(req)).toBe(null);
  });

  it('extracts only 64-char lowercase hex device secrets from bearer tokens', () => {
    const secret = 'a'.repeat(64);
    expect(
      extractDeviceSecret({
        headers: { authorization: `Bearer ${secret}` },
      } as unknown as FastifyRequest)
    ).toBe(secret);
    expect(
      extractDeviceSecret({
        headers: { authorization: 'Bearer aaa.bbb.ccc' },
      } as unknown as FastifyRequest)
    ).toBe(null);
    expect(
      extractDeviceSecret({
        headers: { authorization: `Bearer ${'A'.repeat(64)}` },
      } as unknown as FastifyRequest)
    ).toBe(null);
  });
});
