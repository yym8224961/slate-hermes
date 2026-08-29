import { afterEach, describe, expect, it } from 'bun:test';
import { pushDashboardDataAndVerify } from './slate-ingest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Slate dashboard push readback', () => {
  it('POSTs a versioned envelope and accepts an exact GET readback', async () => {
    const methods: string[] = [];
    const data = { schema_version: 1, monthly: { expense_amount: '13.08' } };
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ version: 1, data });
        return Response.json({
          id: 'content-id',
          image_etag: 'image-etag',
          manifest_etag: 'manifest-etag',
          rendered_at: '2026-08-30T01:15:00.000Z',
        });
      }
      return Response.json({ monthly: { expense_amount: '13.08' }, schema_version: 1 });
    }) as typeof fetch;

    const result = await pushDashboardDataAndVerify({
      slateAPIBase: 'http://slate:3001',
      contentID: 'content-id',
      data,
    });

    expect(methods).toEqual(['POST', 'GET']);
    expect(result.image_etag).toBe('image-etag');
  });

  it('rejects a successful POST when GET returns different data', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({
            id: 'content-id',
            image_etag: 'image-etag',
            manifest_etag: 'manifest-etag',
            rendered_at: '2026-08-30T01:15:00.000Z',
          })
        : Response.json({ schema_version: 1, recent: { summary_text: 'stale' } })) as typeof fetch;

    await expect(
      pushDashboardDataAndVerify({
        slateAPIBase: 'http://slate:3001',
        contentID: 'content-id',
        data: { schema_version: 1, recent: { summary_text: 'fresh' } },
      })
    ).rejects.toThrow('readback did not match');
  });
});
