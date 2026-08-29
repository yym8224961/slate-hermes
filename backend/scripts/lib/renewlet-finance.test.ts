import { describe, expect, it } from 'bun:test';
import {
  buildMonthlyFinanceData,
  buildRecentFinanceData,
  currentMonthlyRange,
  fetchAllRenewletTransactions,
  fetchRenewletReportBasis,
  normalizeRenewletBase,
  normalizeSlateBase,
  parseRenewletReportBasisConfig,
  transactionsNeedReportBasis,
  type RenewletTransaction,
} from './renewlet-finance';

const updatedAt = new Date('2026-08-29T17:15:00.000Z');
const timeZone = 'Asia/Shanghai';

describe('Renewlet finance projection', () => {
  it('uses exact local-month UTC bounds for Asia/Shanghai', () => {
    expect(currentMonthlyRange(updatedAt, timeZone)).toEqual({
      month: '2026-08',
      monthLabel: '2026年8月',
      from: '2026-07-31T16:00:00.000Z',
      to: '2026-08-31T15:59:59.999Z',
    });
  });

  it('keeps income, refund, and expense separate and converts foreign currency with the locked Renewlet basis', () => {
    const range = currentMonthlyRange(updatedAt, timeZone);
    const data = buildMonthlyFinanceData({
      transactions: [
        transaction({ id: '1', amount: '13.08', category: '餐饮' }),
        transaction({ id: '2', amount: '457', category: '购物' }),
        transaction({ id: '3', type: 'income', amount: '5428.30', category: '工资' }),
        transaction({ id: '4', type: 'refund', amount: '0.1', category: '退款' }),
        transaction({ id: '5', amount: '20', currency: 'USD', category: '软件订阅' }),
      ],
      total: 5,
      range,
      reportingCurrency: 'CNY',
      reportBasis: {
        month: '2026-08',
        base: 'USD',
        rates: { USD: 1, CNY: 6.72 },
        sourceDate: '2026-08-29',
        capturedAt: '2026-08-29T12:00:00Z',
      },
      updatedAt,
      timeZone,
    });

    expect(data).toMatchObject({
      net_amount_text: 'CNY +4,823.92',
      transaction_count_text: '5 笔实际流水',
      expense_amount: '604.48',
      income_amount: '5,428.30',
      refund_amount: '0.10',
      category1: { name: '购物', amount: '457.00', share_text: '75.6%' },
      category2: { name: '软件订阅', amount: '134.40', share_text: '22.2%' },
      category3: { name: '餐饮', amount: '13.08', share_text: '2.2%' },
      show_empty_expenses: false,
      coverage_text: 'CNY · 锁定汇率 2026-08-29 · 5/5 笔',
      updated_text: '更新 08-30 01:15',
    });
  });

  it('does not require a report snapshot when every transaction already uses the reporting currency', () => {
    const transactions = [transaction({ amount: '13.08' })];
    expect(transactionsNeedReportBasis(transactions, 'CNY')).toBe(false);
    expect(transactionsNeedReportBasis(transactions, 'USD')).toBe(true);

    const data = buildMonthlyFinanceData({
      transactions,
      total: 1,
      range: currentMonthlyRange(updatedAt, timeZone),
      reportingCurrency: 'CNY',
      reportBasis: null,
      updatedAt,
      timeZone,
    });

    expect(data.coverage_text).toBe('CNY · 无需汇率换算 · 1/1 笔');
    expect(data.expense_amount).toBe('13.08');
  });

  it('fails closed if foreign currency is projected without a locked snapshot', () => {
    expect(() =>
      buildMonthlyFinanceData({
        transactions: [transaction({ currency: 'USD' })],
        total: 1,
        range: currentMonthlyRange(updatedAt, timeZone),
        reportingCurrency: 'CNY',
        reportBasis: null,
        updatedAt,
        timeZone,
      })
    ).toThrow('locked exchange-rate snapshot is required');
  });

  it('sorts recent expenses by occurrence and falls back to category when merchant is absent', () => {
    const data = buildRecentFinanceData({
      transactions: [
        transaction({ id: 'older', occurredAt: '2026-08-28T10:00:00Z', merchant: null }),
        transaction({
          id: 'newer',
          occurredAt: '2026-08-29T10:00:00Z',
          merchant: '瑞幸咖啡',
          amount: '13.08',
        }),
        transaction({ id: 'income', type: 'income', occurredAt: '2026-08-30T10:00:00Z' }),
      ],
      updatedAt,
      timeZone,
    });

    expect(data).toMatchObject({
      summary_text: '最近 2 笔 · 按发生时间倒序',
      row1: { visible: true, date: '08/29', merchant: '瑞幸咖啡', amount: '-¥13.08' },
      row2: { visible: true, date: '08/28', merchant: '餐饮' },
      row3: { visible: false },
      show_empty: false,
      source_text: '来源 Renewlet',
    });
  });

  it('follows every Renewlet cursor and preserves the server total', async () => {
    const urls: string[] = [];
    const result = await fetchAllRenewletTransactions({
      base: 'https://renewlet.example.com',
      token: 'redacted-test-token',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
      fetchJSON: async (url) => {
        urls.push(url);
        return urls.length === 1
          ? {
              ok: true,
              data: {
                transactions: [transaction({ id: 'page-1' })],
                nextCursor: 'next-page',
                total: 2,
              },
            }
          : {
              ok: true,
              data: {
                transactions: [transaction({ id: 'page-2' })],
                nextCursor: null,
                total: 2,
              },
            };
      },
    });

    expect(result.transactions.map((item) => item.id)).toEqual(['page-1', 'page-2']);
    expect(result.total).toBe(2);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('next-page');
    expect(urls.every((url) => !url.includes('redacted-test-token'))).toBe(true);
  });

  it('requires one exact locked exchange-rate snapshot for the requested month', async () => {
    const basis = await fetchRenewletReportBasis({
      base: 'https://renewlet.example.com',
      token: 'redacted-test-token',
      month: '2026-08',
      fetchJSON: async () => ({
        ok: true,
        data: {
          snapshots: [
            {
              schemaVersion: 1,
              month: '2026-08',
              base: 'USD',
              rates: { USD: 1, CNY: 6.72 },
              requestedProvider: 'frankfurter',
              provider: 'frankfurter',
              sourceDate: '2026-08-29',
              capturedAt: '2026-08-29T12:00:00Z',
            },
          ],
        },
      }),
    });

    expect(basis).toEqual({
      month: '2026-08',
      base: 'USD',
      rates: { USD: 1, CNY: 6.72 },
      sourceDate: '2026-08-29',
      capturedAt: '2026-08-29T12:00:00Z',
    });
  });

  it('rejects a protected fallback snapshot from another month', () => {
    expect(() =>
      parseRenewletReportBasisConfig(
        JSON.stringify({
          schemaVersion: 1,
          month: '2026-07',
          base: 'USD',
          rates: { USD: 1, CNY: 6.72 },
          sourceDate: '2026-07-31',
          capturedAt: '2026-07-31T12:00:00Z',
        }),
        '2026-08'
      )
    ).toThrow('no unique locked exchange-rate snapshot for 2026-08');
  });

  it('accepts a protected fallback without inventing capture metadata', () => {
    expect(
      parseRenewletReportBasisConfig(
        JSON.stringify({
          month: '2026-08',
          base: 'USD',
          rates: { USD: 1, CNY: 6.7175 },
          sourceDate: '2026-08-29',
        }),
        '2026-08'
      )
    ).toEqual({
      month: '2026-08',
      base: 'USD',
      rates: { USD: 1, CNY: 6.7175 },
      sourceDate: '2026-08-29',
      capturedAt: null,
    });
  });
});

describe('Renewlet base URL policy', () => {
  it('allows HTTPS origins and Docker-internal HTTP origins', () => {
    expect(normalizeRenewletBase('https://west3.kylecloud.top:3300/')).toBe(
      'https://west3.kylecloud.top:3300'
    );
    expect(normalizeRenewletBase('http://web:3000')).toBe('http://web:3000');
    expect(normalizeRenewletBase('http://192.168.31.6:3300')).toBe('http://192.168.31.6:3300');
  });

  it('rejects a bearer-token hop over public plain HTTP', () => {
    expect(() => normalizeRenewletBase('http://west3.kylecloud.top:3300')).toThrow(
      'plain HTTP only for a private, loopback, or Docker-internal host'
    );
  });

  it('applies the same capability-protection policy to Slate', () => {
    expect(normalizeSlateBase('https://west3.kylecloud.top:3002/')).toBe(
      'https://west3.kylecloud.top:3002'
    );
    expect(normalizeSlateBase('http://slate:3001')).toBe('http://slate:3001');
    expect(() => normalizeSlateBase('http://west3.kylecloud.top:3002')).toThrow(
      'SLATE_API_BASE may use plain HTTP only for a private, loopback, or Docker-internal host'
    );
  });
});

function transaction(overrides: Partial<RenewletTransaction> = {}): RenewletTransaction {
  return {
    id: 'txn',
    type: 'expense',
    amount: '10',
    currency: 'CNY',
    occurredAt: '2026-08-29T10:00:00Z',
    category: '餐饮',
    merchant: null,
    ...overrides,
  };
}
