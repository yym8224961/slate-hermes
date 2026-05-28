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
});
