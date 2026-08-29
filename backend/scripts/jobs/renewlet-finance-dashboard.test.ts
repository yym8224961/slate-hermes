import { afterEach, describe, expect, it } from 'bun:test';
import { currentMonthlyRange } from '../lib/renewlet-finance';
import { runRenewletFinanceDashboardJob } from './renewlet-finance-dashboard';

const originalFetch = globalThis.fetch;
const envNames = [
  'SLATE_JOB_TIME_ZONE',
  'SLATE_API_BASE',
  'RENEWLET_BASE',
  'RENEWLET_HERMES_TOKEN',
  'RENEWLET_MONTHLY_CONTENT_ID',
  'RENEWLET_RECENT_CONTENT_ID',
  'RENEWLET_REPORTING_CURRENCY',
  'RENEWLET_ALLOW_REPORT_BASIS_FALLBACK',
  'RENEWLET_REPORT_BASIS_JSON',
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Renewlet finance dashboard orchestration', () => {
  it('uses the protected migration snapshot only for an explicit 404', async () => {
    configureJobEnv();
    const month = currentMonthlyRange(new Date(), 'Asia/Shanghai').month;
    process.env.RENEWLET_ALLOW_REPORT_BASIS_FALLBACK = 'true';
    process.env.RENEWLET_REPORT_BASIS_JSON = JSON.stringify({
      month,
      base: 'USD',
      rates: { USD: 1, CNY: 6.72 },
      sourceDate: `${month}-01`,
    });
    const calls = installFetchScenario(404);

    await runRenewletFinanceDashboardJob();

    expect(calls.reportBasis).toBe(1);
    expect(calls.monthlyPosts).toBe(1);
    expect(calls.recentPosts).toBe(1);
  });

  it('does not hide a report-basis server error and still updates the independent recent page', async () => {
    configureJobEnv();
    const month = currentMonthlyRange(new Date(), 'Asia/Shanghai').month;
    process.env.RENEWLET_ALLOW_REPORT_BASIS_FALLBACK = 'true';
    process.env.RENEWLET_REPORT_BASIS_JSON = JSON.stringify({
      month,
      base: 'USD',
      rates: { USD: 1, CNY: 6.72 },
      sourceDate: `${month}-01`,
    });
    const calls = installFetchScenario(500);

    await expect(runRenewletFinanceDashboardJob()).rejects.toThrow(
      'One or more Renewlet finance dashboards failed to sync'
    );
    expect(calls.reportBasis).toBe(1);
    expect(calls.monthlyPosts).toBe(0);
    expect(calls.recentPosts).toBe(1);
  });
});

function configureJobEnv(): void {
  process.env.SLATE_JOB_TIME_ZONE = 'Asia/Shanghai';
  process.env.SLATE_API_BASE = 'https://slate.example.com';
  process.env.RENEWLET_BASE = 'https://renewlet.example.com';
  process.env.RENEWLET_HERMES_TOKEN = 'rlh_test_job_token';
  process.env.RENEWLET_MONTHLY_CONTENT_ID = 'monthly-id';
  process.env.RENEWLET_RECENT_CONTENT_ID = 'recent-id';
  process.env.RENEWLET_REPORTING_CURRENCY = 'CNY';
}

function installFetchScenario(reportBasisStatus: number): {
  reportBasis: number;
  monthlyPosts: number;
  recentPosts: number;
} {
  const calls = { reportBasis: 0, monthlyPosts: 0, recentPosts: 0 };
  const readbacks = new Map<string, unknown>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'renewlet.example.com') {
      if (url.pathname.endsWith('/reporting/exchange-rate-snapshots')) {
        calls.reportBasis += 1;
        return new Response('report basis unavailable', { status: reportBasisStatus });
      }
      const recent = url.searchParams.get('type') === 'expense';
      return Response.json({
        ok: true,
        data: {
          transactions: [
            {
              id: recent ? 'recent' : 'monthly',
              type: 'expense',
              amount: recent ? '13.08' : '10',
              currency: recent ? 'CNY' : 'USD',
              occurredAt: new Date().toISOString(),
              category: '测试',
              merchant: '测试商户',
            },
          ],
          nextCursor: null,
          total: 1,
        },
      });
    }

    const contentID = url.pathname.split('/').at(-2)!;
    if (init?.method === 'POST') {
      const envelope = JSON.parse(String(init.body)) as { data: unknown };
      readbacks.set(contentID, envelope.data);
      if (contentID === 'monthly-id') calls.monthlyPosts += 1;
      if (contentID === 'recent-id') calls.recentPosts += 1;
      return Response.json({ rendered_at: new Date().toISOString() });
    }
    return Response.json(readbacks.get(contentID));
  }) as typeof fetch;
  return calls;
}
