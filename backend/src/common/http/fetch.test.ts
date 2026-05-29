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
  it('defaults object request bodies to application/json when no content type is provided', async () => {
    let contentType: string | null = null;
    let body: BodyInit | null | undefined;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      contentType = new Headers(init?.headers).get('Content-Type');
      body = init?.body;
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fetchResponse('https://example.invalid/post', {
      method: 'POST',
      body: { ok: true },
    });

    expect(contentType).toBe('application/json');
    expect(body).toBe('{"ok":true}');
  });

  it('does not mark plain string request bodies as application/json by default', async () => {
    let contentType: string | null = 'unexpected';
    let body: BodyInit | null | undefined;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      contentType = new Headers(init?.headers).get('Content-Type');
      body = init?.body;
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fetchResponse('https://example.invalid/plain', {
      method: 'POST',
      body: 'plain text',
    });

    expect(contentType).toBe(null);
    expect(body).toBe('plain text');
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

  it('rejects non-json content types for JSON responses', async () => {
    globalThis.fetch = (async () => {
      return new Response('<html>ok</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof fetch;

    await expect(fetchJson('https://example.invalid/not-json')).rejects.toThrow(
      'Expected JSON response'
    );
  });

  it('accepts json suffix content types for JSON responses', async () => {
    globalThis.fetch = (async () => {
      return new Response('{"ok":true}', {
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }) as unknown as typeof fetch;

    await expect(fetchJson<{ ok: boolean }>('https://example.invalid/problem')).resolves.toEqual({
      ok: true,
    });
  });

  it('redacts URL credentials and query from HTTP status errors', async () => {
    globalThis.fetch = (async () => {
      return new Response('bad token', { status: 403 });
    }) as unknown as typeof fetch;

    try {
      await fetchText('https://user:pass@example.invalid/secret?token=abc#frag');
      throw new Error('expected HTTP error');
    } catch (err) {
      expect(String((err as Error).message)).toContain('https://example.invalid/secret');
      expect(String((err as Error).message)).not.toContain('token=abc');
      expect(String((err as Error).message)).not.toContain('user:pass');
    }
  });

  it('only reads a bounded prefix from huge error response bodies', async () => {
    globalThis.fetch = (async () => {
      return new Response('x'.repeat(64 * 1024), { status: 502 });
    }) as unknown as typeof fetch;

    try {
      await fetchText('https://example.invalid/huge-error');
      throw new Error('expected HTTP error');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpStatusError);
      expect((err as HttpStatusError).bodySnippet.length).toBeLessThanOrEqual(512);
    }
  });

  it('throws an HTTP status error for text responses too', async () => {
    globalThis.fetch = (async () => {
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(fetchText('https://example.invalid/limited')).rejects.toThrow('HTTP 429');
  });

  it('blocks obvious private-network URLs by default', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('unexpected');
    }) as unknown as typeof fetch;

    await expect(fetchText('http://127.0.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://localhost/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://0177.0.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://0x7f.0.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://2130706433/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://100.64.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://198.18.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://240.0.0.1/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    await expect(fetchText('http://[::ffff:127.0.0.1]/admin')).rejects.toThrow(
      'private network URL is not allowed'
    );
    expect(called).toBe(false);
  });

  it('does not treat ordinary hostnames beginning with fc or fd as private IPv6 addresses', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch;

    await expect(fetchText('https://fca.com/')).resolves.toBe('ok');
    expect(called).toBe(true);
  });

  it('can explicitly allow private-network URLs for trusted callers', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch;

    await expect(
      fetchText('http://127.0.0.1/healthz', { allowPrivateNetwork: true })
    ).resolves.toBe('ok');
    expect(called).toBe(true);
  });
});
