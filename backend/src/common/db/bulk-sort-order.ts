import { Prisma } from '@prisma/client';

// 把 order 中的 id 按下标依次写回该表的 sort_order 列。
// 两步式 staging：先把每行写到唯一的负数槽位，再 finalize 成 0..N-1，避开 (scope, sort_order)
// 唯一约束在 reshuffle 中出现的中间冲突。
async function bulkSetSortOrder(
  tx: Prisma.TransactionClient,
  table: 'devices' | 'groups' | 'contents',
  scopeColumn: 'owner_user_id' | 'group_id',
  scopeValue: string,
  order: string[]
): Promise<void> {
  if (order.length === 0) return;
  const tableSql = Prisma.raw(`\`${table}\``);
  const scopeColSql = Prisma.raw(`\`${scopeColumn}\``);
  const ids = Prisma.join(order);
  for (const stage of ['staging', 'final'] as const) {
    await tx.$executeRaw`
      UPDATE ${tableSql}
      SET \`sort_order\` = CASE \`id\`
        ${Prisma.join(
          order.map(
            (id, idx) => Prisma.sql`WHEN ${id} THEN ${stage === 'final' ? idx : -(idx + 1)}`
          ),
          ' '
        )}
      END
      WHERE ${scopeColSql} = ${scopeValue} AND \`id\` IN (${ids})
    `;
  }
}

export function bulkSetDeviceSortOrder(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  order: string[]
): Promise<void> {
  return bulkSetSortOrder(tx, 'devices', 'owner_user_id', ownerUserId, order);
}

export function bulkSetGroupSortOrder(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  order: string[]
): Promise<void> {
  return bulkSetSortOrder(tx, 'groups', 'owner_user_id', ownerUserId, order);
}

export function bulkSetContentSortOrder(
  tx: Prisma.TransactionClient,
  groupId: string,
  order: string[]
): Promise<void> {
  return bulkSetSortOrder(tx, 'contents', 'group_id', groupId, order);
}
