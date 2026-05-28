import { afterEach, describe, expect, it } from 'bun:test';
import { fetchJson, fetchResponse, fetchText, fetchWithTimeout, HttpStatusError } from './fetch';

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

  it('uses a timeout signal by default', async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fetchWithTimeout('https://example.invalid');

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetch helpers', () => {
  it('defaults string request bodies to application/json when no content type is provided', async () => {
    let contentType: string | null = null;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      contentType = new Headers(init?.headers).get('Content-Type');
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fetchResponse('https://example.invalid/post', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });

    expect(contentType).toBe('application/json');
  });

  it('does not default URLSearchParams request bodies to application/json', async () => {
    let contentType: string | null = 'unexpected';
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      contentType = new Headers(init?.headers).get('Content-Type');
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fetchResponse('https://example.invalid/form', {
      method: 'POST',
      body: new URLSearchParams({ ok: 'true' }),
    });

    expect(contentType).toBe(null);
  });

  it('throws an HTTP status error before JSON parsing non-2xx responses', async () => {
    globalThis.fetch = (async () => {
      return new Response('<html>not found</html>', {
        status: 404,
        statusText: 'Not Found',
      });
    }) as unknown as typeof fetch;

    try {
      await fetchJson('https://example.invalid/missing');
      throw new Error('expected HTTP error');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpStatusError);
      expect((err as HttpStatusError).status).toBe(404);
      expect((err as HttpStatusError).bodySnippet).toBe('<html>not found</html>');
    }
  });

  it('throws an HTTP status error for text responses too', async () => {
    globalThis.fetch = (async () => {
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(fetchText('https://example.invalid/limited')).rejects.toThrow('HTTP 429');
  });
});
