export async function claimLeaseJobs<Row, Job>(
  rows: Row[],
  buildJob: (row: Row) => Job | null,
  tryClaim: (row: Row, job: Job) => Promise<boolean>
): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const row of rows) {
    const job = buildJob(row);
    if (!job) continue;
    if (await tryClaim(row, job)) jobs.push(job);
  }
  return jobs;
}
