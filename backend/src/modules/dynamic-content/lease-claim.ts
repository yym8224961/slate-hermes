/**
 * Best-effort distributed lease helper used by DynamicContentSchedulerService.
 *
 * Each BACKGROUND_WORKERS process first reads due rows, then tries to claim each
 * row with an updateMany guarded by the same due/expired-lease predicate. Only
 * the process that updates exactly one row receives the job. Successful renders
 * clear the lease in DynamicContentRendererService; failed renders call
 * markRetry() and clear the lease after scheduling the next retry. If a worker
 * dies mid-render, dynamicRefreshLeaseUntil expires and another worker can claim
 * the row on a later scheduler tick.
 */
export async function claimLeaseJobs<Row, Job>(
  rows: Row[],
  buildJob: (row: Row) => Job | null,
  tryClaim: (row: Row, job: Job) => Promise<boolean>
): Promise<Job[]> {
  const candidates: Array<{ row: Row; job: Job }> = [];
  for (const row of rows) {
    const job = buildJob(row);
    if (!job) continue;
    candidates.push({ row, job });
  }
  const claimed = await Promise.all(
    candidates.map(async ({ row, job }) => ((await tryClaim(row, job)) ? job : null))
  );
  return claimed.flatMap((job) => (job === null ? [] : [job]));
}
