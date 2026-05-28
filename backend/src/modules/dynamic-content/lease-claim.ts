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
