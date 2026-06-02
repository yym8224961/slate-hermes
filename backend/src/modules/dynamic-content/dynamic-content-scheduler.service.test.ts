import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../../infra/config/app.config';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { DynamicContentSchedulerService } from './dynamic-content-scheduler.service';

describe('DynamicContentSchedulerService', () => {
  it('looks up the next due job when the current tick has no work', async () => {
    const calls: string[] = [];
    const prisma = {
      content: {
        findMany: async () => {
          calls.push('findMany');
          return [];
        },
        findFirst: async () => {
          calls.push('findFirst');
          return { dynamicRefreshDueAt: new Date(Date.now() + 60_000) };
        },
      },
    };
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      prisma as unknown as PrismaService,
      {} as DynamicContentRendererService
    );

    await service.tick();
    service.onModuleDestroy();

    expect(calls).toEqual(['findMany', 'findFirst']);
  });

  it('clears its scheduled timer on module destroy', () => {
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {} as PrismaService,
      {} as DynamicContentRendererService
    );

    service.onModuleInit();
    const loop = (service as unknown as { loop: { timer: unknown } }).loop;
    expect(loop.timer).not.toBeNull();

    service.onModuleDestroy();
    expect(loop.timer).toBeNull();
  });

  it('logs retry marker failures instead of swallowing them inside a job catch', async () => {
    const logged: string[] = [];
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {
        content: {
          findMany: async () => [
            { id: 'content-1', dynamicType: 'weather', dynamicRefreshAttempts: 0 },
          ],
          updateMany: async ({
            data,
          }: {
            data?: { dynamicRefreshLeaseUntil?: Date; dynamicRefreshAttempts?: unknown };
          }) => {
            if (data?.dynamicRefreshAttempts) return { count: 1 };
            throw new Error('db unavailable');
          },
          findFirst: async () => null,
        },
      } as unknown as PrismaService,
      {
        renderDynamicContent: async () => {
          throw new Error('render failed');
        },
      } as unknown as DynamicContentRendererService
    );
    (
      service as unknown as {
        logger: { warn: (msg: string) => void; error: (msg: string) => void };
      }
    ).logger = {
      warn: (msg: string) => logged.push(`warn:${msg}`),
      error: (msg: string) => logged.push(`error:${msg}`),
    };

    await service.tick();
    service.onModuleDestroy();

    expect(logged.some((msg) => msg.includes('Dynamic refresh job failed'))).toBe(true);
    expect(logged.some((msg) => msg.includes('Dynamic refresh retry marker failed'))).toBe(true);
  });
});
