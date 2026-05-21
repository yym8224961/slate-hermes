import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { claimLeaseJobs } from './lease-claim';

const WORKER_INTERVAL_MS = 10_000;
const WORKER_BATCH_SIZE = 5;
const LEASE_MS = 180_000;
const RETRY_BASE_DELAY_MS = 15_000;
const RETRY_MAX_DELAY_MS = 10 * 60_000;

interface RefreshJob {
  id: string;
  dynamicType: string;
  attempts: number;
  leaseUntil: Date;
}

@Injectable()
export class DynamicContentSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicContentSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly renderer: DynamicContentRendererService
  ) {}

  onModuleInit(): void {
    if (!this.config.backgroundWorkers) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WORKER_INTERVAL_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.claimDueJobs(WORKER_BATCH_SIZE);
      for (const job of jobs) {
        await this.renderDue(job.id, job.dynamicType).catch(async (err: unknown) => {
          this.logger.warn(
            `dynamic refresh job failed content=${job.id}: ${err instanceof Error ? err.message : String(err)}`
          );
          await this.markRetry(job, err);
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async claimDueJobs(limit: number): Promise<RefreshJob[]> {
    const now = new Date();
    const rows = await this.prisma.content.findMany({
      where: {
        kind: 'dynamic',
        dynamicType: { not: null },
        dynamicRefreshDueAt: { not: null, lte: now },
        OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
      },
      orderBy: [{ dynamicRefreshDueAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, dynamicType: true, dynamicRefreshAttempts: true },
    });
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return claimLeaseJobs(
      rows,
      (row) =>
        row.dynamicType
          ? {
              id: row.id,
              dynamicType: row.dynamicType,
              attempts: row.dynamicRefreshAttempts + 1,
              leaseUntil,
            }
          : null,
      async (row) => {
        const claimed = await this.prisma.content.updateMany({
          where: {
            id: row.id,
            kind: 'dynamic',
            dynamicRefreshDueAt: { not: null, lte: now },
            OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
          },
          data: {
            dynamicRefreshLeaseUntil: leaseUntil,
            dynamicRefreshAttempts: { increment: 1 },
          },
        });
        return claimed.count === 1;
      }
    );
  }

  private async renderDue(contentId: string, dynamicType: string): Promise<void> {
    const result = await this.renderer.renderDynamicContent(contentId);
    this.logger.log(
      `refreshed dynamic content=${contentId} type=${dynamicType}` +
        (result.unchanged ? ' unchanged=1' : ' changed=1')
    );
  }

  private async markRetry(job: RefreshJob, err: unknown): Promise<void> {
    const now = new Date();
    const delayMs = Math.min(
      RETRY_MAX_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2 ** Math.max(job.attempts - 1, 0)
    );
    await this.prisma.content.updateMany({
      where: {
        id: job.id,
        kind: 'dynamic',
        dynamicRefreshLeaseUntil: job.leaseUntil,
      },
      data: {
        dynamicLastError: formatError(err).slice(0, 512),
        dynamicRefreshDueAt: new Date(now.getTime() + delayMs),
        dynamicRefreshLeaseUntil: null,
      },
    });
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
