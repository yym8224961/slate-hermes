import type { PrismaClientLike } from './prisma-utils';

type SortOrderDelegate = {
  findFirst(args: {
    where: Record<string, string>;
    orderBy: { sortOrder: 'desc' };
    select: { sortOrder: true };
  }): Promise<{ sortOrder: number } | null>;
};

export async function nextContentSortOrder(
  client: PrismaClientLike,
  groupId: string
): Promise<number> {
  return nextSortOrderFor(client.content, { groupId });
}

export async function nextDeviceSortOrder(
  client: PrismaClientLike,
  ownerUserId: string
): Promise<number> {
  return nextSortOrderFor(client.device, { ownerUserId });
}

export async function nextGroupSortOrder(
  client: PrismaClientLike,
  ownerUserId: string
): Promise<number> {
  return nextSortOrderFor(client.group, { ownerUserId });
}

async function nextSortOrderFor(
  delegate: SortOrderDelegate,
  where: Record<string, string>
): Promise<number> {
  const last = await delegate.findFirst({
    where,
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return nextSortOrder(last);
}

function nextSortOrder(row: { sortOrder: number } | null): number {
  return (row?.sortOrder ?? -1) + 1;
}
