import { describe, expect, it } from 'bun:test';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { BlobService } from '../../infra/blob/blob.service';
import { GroupsService } from './groups.service';

describe('GroupsService.reorderGroups', () => {
  it('updates changed group manifest etags in one batched path without recomputing content etags', async () => {
    const findManyCalls: unknown[] = [];
    const executeRawCalls: unknown[] = [];
    const tx = {
      $queryRaw: async () => [{ id: 'user-1' }],
      $executeRaw: async (...args: unknown[]) => {
        executeRawCalls.push(args);
      },
      group: {
        findUnique: async () => {
          throw new Error('reorderGroups should not run full group etag recompute');
        },
        findMany: async (args: {
          where: { ownerUserId?: string; id?: { in: string[] } };
          select?: Record<string, unknown>;
        }) => {
          findManyCalls.push(args);
          if (!args.where.id) {
            return [
              { id: 'group-1', sortOrder: 0 },
              { id: 'group-2', sortOrder: 1 },
            ];
          }
          return [
            {
              id: 'group-2',
              name: 'Second',
              sortOrder: 0,
              structureEtag: 'structure-2',
              contents: [
                { id: 'content-2a', contentEtag: 'content-etag-2a' },
                { id: 'content-2b', contentEtag: 'content-etag-2b' },
              ],
            },
            {
              id: 'group-1',
              name: 'First',
              sortOrder: 1,
              structureEtag: 'structure-1',
              contents: [{ id: 'content-1a', contentEtag: 'content-etag-1a' }],
            },
          ];
        },
      },
    };
    const prisma = {
      $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    };
    const service = new GroupsService(prisma as unknown as PrismaService, {} as BlobService);

    await service.reorderGroups('user-1', ['group-2', 'group-1']);

    expect(findManyCalls).toHaveLength(2);
    expect((findManyCalls[1] as { where: { id: { in: string[] } } }).where.id.in).toEqual([
      'group-2',
      'group-1',
    ]);
    expect((findManyCalls[1] as { select: { contents: unknown } }).select.contents).toEqual({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, contentEtag: true },
    });
    expect(executeRawCalls).toHaveLength(3);
  });
});
