import { afterEach, describe, expect, it } from 'bun:test';
import { fetchJSON, HTTPResponseError } from './http';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('script HTTP errors', () => {
  it('preserves status for policy decisions while redacting the response body', async () => {
    globalThis.fetch = (async () =>
      new Response('Bearer test-secret /api/v1/contents/capability-secret/data', {
        status: 404,
      })) as typeof fetch;

    try {
      await fetchJSON('https://example.com', {}, 'test request');
      throw new Error('expected fetchJSON to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPResponseError);
      expect((error as HTTPResponseError).status).toBe(404);
      expect((error as Error).message).not.toContain('test-secret');
      expect((error as Error).message).not.toContain('capability-secret');
    }
  });
});
