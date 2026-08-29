#!/usr/bin/env bun

import { createScriptLogger, formatScriptError } from './helpers/script-logger';
import { runRenewletFinanceDashboardJob } from './jobs/renewlet-finance-dashboard';

const logger = createScriptLogger('RenewletFinanceOnce');

async function main(): Promise<void> {
  await runRenewletFinanceDashboardJob();
  logger.info('Renewlet finance dashboard sync completed.');
}

main().catch((error) => {
  logger.error(`Renewlet finance dashboard sync failed: ${formatScriptError(error, 2000)}`);
  process.exit(1);
});
