import { describe, expect, it } from 'bun:test';
import { claimLeaseJobs } from './lease-claim';

describe('claimLeaseJobs', () => {
  it('claims eligible rows concurrently while preserving result order', async () => {
    const order: number[] = [];
    const jobs = await claimLeaseJobs(
      [1, 2, 3],
      (row) => (row === 2 ? null : `job-${row}`),
      async (row) => {
        await new Promise((resolve) => setTimeout(resolve, row === 1 ? 20 : 0));
        order.push(row);
        return true;
      }
    );

    expect(order).toEqual([3, 1]);
    expect(jobs).toEqual(['job-1', 'job-3']);
  });
});
