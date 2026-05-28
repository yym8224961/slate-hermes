import { afterEach, describe, expect, it } from 'bun:test';
import { fetchWithTimeout } from './fetch';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchWithTimeout', () => {
  it('rejects immediately when the upstream signal is already aborted', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('unexpected');
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    try {
      await fetchWithTimeout('https://example.invalid', {
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      throw new Error('expected abort');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
    expect(called).toBe(false);
  });

  it('propagates later upstream aborts to the active fetch', async () => {
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = fetchWithTimeout('https://example.invalid', {
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    controller.abort(new Error('caller canceled'));
    await expect(pending).rejects.toThrow('caller canceled');
  });
});
