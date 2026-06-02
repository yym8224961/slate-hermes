#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScriptLogger, formatScriptError } from './helpers/script-logger';
import { readEnv, readPositiveIntEnv, requireEnv } from './lib/env';
import type { SlateJob } from './lib/job';

const logger = createScriptLogger('SlateJobRunner');
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_JOB_DIR = 'scripts/jobs';

let stopping = false;
let wakeSleep: (() => void) | null = null;

process.on('SIGTERM', () => {
  stopping = true;
  wakeSleep?.();
  logger.info('Received SIGTERM, stopping after current job cycle.');
});

process.on('SIGINT', () => {
  stopping = true;
  wakeSleep?.();
  logger.info('Received SIGINT, stopping after current job cycle.');
});

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      wakeSleep = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

function validateJobID(jobID: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobID)) {
    throw new Error(`Invalid SLATE_JOB=${jobID}. Use a scripts/jobs/<name>.ts basename.`);
  }
}

async function loadJob(jobID: string): Promise<SlateJob> {
  validateJobID(jobID);
  const jobDir = readEnv('SLATE_JOB_DIR') || DEFAULT_JOB_DIR;
  const jobPath = resolve(jobDir, `${jobID}.ts`);
  if (!existsSync(jobPath)) {
    throw new Error(`Job file not found: ${jobPath}`);
  }
  const mod = (await import(pathToFileURL(jobPath).href)) as {
    job?: SlateJob;
    default?: SlateJob;
  };
  const job = mod.job ?? mod.default;
  if (!job || typeof job.run !== 'function') {
    throw new Error(`scripts/jobs/${jobID}.ts must export a SlateJob as "job" or default.`);
  }
  return {
    id: job.id || jobID,
    description: job.description || jobID,
    run: job.run,
  };
}

async function main(): Promise<void> {
  const jobID = requireEnv('SLATE_JOB');
  const job = await loadJob(jobID);

  const intervalSeconds = readPositiveIntEnv(
    'SLATE_JOB_INTERVAL_SECONDS',
    DEFAULT_INTERVAL_SECONDS
  );
  const runOnce = readEnv('SLATE_JOB_RUN_ONCE') === '1';

  logger.info(
    `Starting job ${job.id}: ${job.description}. ` +
      (runOnce ? 'run once.' : `interval=${intervalSeconds}s.`)
  );

  do {
    const startedAt = Date.now();
    try {
      await job.run();
      logger.info(`Job ${job.id} completed in ${Date.now() - startedAt}ms.`);
    } catch (error) {
      logger.error(`Job ${job.id} failed: ${formatScriptError(error, 2000)}`);
    }

    if (runOnce || stopping) break;
    await sleep(intervalSeconds * 1000);
  } while (!stopping);

  logger.info(`Job runner for ${job.id} stopped.`);
}

main().catch((error) => {
  logger.error(`Job runner failed: ${formatScriptError(error, 2000)}`);
  process.exit(1);
});
