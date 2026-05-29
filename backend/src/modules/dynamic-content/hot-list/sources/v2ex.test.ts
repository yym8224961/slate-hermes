import { afterEach, describe, expect, it } from 'bun:test';
import { v2exSource } from './v2ex';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('v2exSource', () => {
  it('treats non-array API responses as an empty list', async () => {
    globalThis.fetch = (async () => {
      return Response.json({ error: 'rate limited' });
    }) as unknown as typeof fetch;

    await expect(v2exSource.fetch({ signal: new AbortController().signal })).resolves.toEqual([]);
  });
});
