import type { DashboardDataPayloadT } from 'shared';
import { createScriptLogger } from '../helpers/script-logger';
import { readEnv, requireEnv, stripTrailingSlash } from '../lib/env';
import { fetchJSON, HTTPResponseError } from '../lib/http';
import type { SlateJob } from '../lib/job';
import {
  buildMonthlyFinanceData,
  buildRecentFinanceData,
  currentMonthlyRange,
  fetchAllRenewletTransactions,
  fetchRecentRenewletExpenses,
  fetchRenewletReportBasis,
  normalizeRenewletBase,
  normalizeSlateBase,
  parseRenewletReportBasisConfig,
  transactionsNeedReportBasis,
  type RenewletReportBasis,
} from '../lib/renewlet-finance';
import { pushDashboardDataAndVerify } from '../lib/slate-ingest';
import { readScriptTimeZone } from '../lib/time';

const logger = createScriptLogger('RenewletFinanceDashboard');
const DEFAULT_REPORTING_CURRENCY = 'CNY';

interface RenewletFinanceConfig {
  renewletBase: string;
  renewletToken: string;
  slateAPIBase: string;
  monthlyContentID: string;
  recentContentID: string;
  reportingCurrency: string;
  timeZone: string;
  reportBasisJSON: string;
  allowReportBasisFallback: boolean;
}

function readConfig(): RenewletFinanceConfig {
  const reportingCurrency = (
    readEnv('RENEWLET_REPORTING_CURRENCY') || DEFAULT_REPORTING_CURRENCY
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(reportingCurrency)) {
    throw new Error('RENEWLET_REPORTING_CURRENCY must be a three-letter ISO currency code.');
  }
  const monthlyContentID = requireEnv('RENEWLET_MONTHLY_CONTENT_ID');
  const recentContentID = requireEnv('RENEWLET_RECENT_CONTENT_ID');
  if (monthlyContentID === recentContentID) {
    throw new Error(
      'RENEWLET_MONTHLY_CONTENT_ID and RENEWLET_RECENT_CONTENT_ID must be different.'
    );
  }
  return {
    renewletBase: normalizeRenewletBase(requireEnv('RENEWLET_BASE')),
    renewletToken: requireEnv('RENEWLET_HERMES_TOKEN'),
    slateAPIBase: normalizeSlateBase(stripTrailingSlash(requireEnv('SLATE_API_BASE'))),
    monthlyContentID,
    recentContentID,
    reportingCurrency,
    timeZone: readScriptTimeZone(),
    reportBasisJSON: readEnv('RENEWLET_REPORT_BASIS_JSON'),
    allowReportBasisFallback: readEnv('RENEWLET_ALLOW_REPORT_BASIS_FALLBACK') === 'true',
  };
}

async function readReportBasis(
  config: RenewletFinanceConfig,
  month: string
): Promise<RenewletReportBasis> {
  try {
    return await fetchRenewletReportBasis({
      base: config.renewletBase,
      token: config.renewletToken,
      month,
      fetchJSON,
    });
  } catch (error) {
    if (
      !config.allowReportBasisFallback ||
      !config.reportBasisJSON ||
      !(error instanceof HTTPResponseError) ||
      error.status !== 404
    ) {
      throw error;
    }
    const basis = parseRenewletReportBasisConfig(config.reportBasisJSON, month);
    logger.warn(
      `Renewlet report-basis API was unavailable; using the locked ${basis.month} snapshot from the protected runtime configuration.`
    );
    return basis;
  }
}

export async function runRenewletFinanceDashboardJob(): Promise<void> {
  const config = readConfig();
  const updatedAt = new Date();
  const range = currentMonthlyRange(updatedAt, config.timeZone);
  const [monthlyResult, recentResult] = await Promise.all([
    fetchAllRenewletTransactions({
      base: config.renewletBase,
      token: config.renewletToken,
      from: range.from,
      to: range.to,
      fetchJSON,
    }),
    fetchRecentRenewletExpenses({
      base: config.renewletBase,
      token: config.renewletToken,
      fetchJSON,
    }),
  ]);

  const recentData = buildRecentFinanceData({
    transactions: recentResult.transactions,
    updatedAt,
    timeZone: config.timeZone,
  });

  const monthlyPush = (async () => {
    const needsReportBasis = transactionsNeedReportBasis(
      monthlyResult.transactions,
      config.reportingCurrency
    );
    const reportBasis = needsReportBasis ? await readReportBasis(config, range.month) : null;
    const monthlyData = buildMonthlyFinanceData({
      transactions: monthlyResult.transactions,
      total: monthlyResult.total,
      range,
      reportingCurrency: config.reportingCurrency,
      reportBasis,
      updatedAt,
      timeZone: config.timeZone,
    });
    await pushDashboardDataAndVerify({
      slateAPIBase: config.slateAPIBase,
      contentID: config.monthlyContentID,
      data: { schema_version: 1, monthly: monthlyData } satisfies DashboardDataPayloadT,
    });
  })();
  const recentPush = pushDashboardDataAndVerify({
    slateAPIBase: config.slateAPIBase,
    contentID: config.recentContentID,
    data: { schema_version: 1, recent: recentData } satisfies DashboardDataPayloadT,
  });

  const results = await Promise.allSettled([monthlyPush, recentPush]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Renewlet finance dashboards failed to sync.');
  }

  logger.info(
    `Synced Renewlet finance dashboards for ${range.month}: monthly=${monthlyResult.transactions.length}, recent=${recentResult.transactions.length}.`
  );
}

export const job: SlateJob = {
  id: 'renewlet-finance-dashboard',
  description:
    'Read Renewlet actual transactions and update Slate monthly cashflow and recent expense frames.',
  run: runRenewletFinanceDashboardJob,
};
