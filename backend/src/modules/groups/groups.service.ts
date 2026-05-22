import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GroupSummaryT } from 'shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { lockUserRow } from '../../common/db/row-locks';
import { bulkSetGroupSortOrder } from '../../common/db/bulk-sort-order';
import { audioBlobContentId } from '../audio/audio-blob-id';
import { deviceStatusBarText } from '../contents/content-status-bar';

interface GroupListEntry {
  id: string;
  name: string;
  structureEtag: string;
  manifestEtag: string;
  sortOrder: number;
  _count: { contents: number };
}

export interface CycleResult {
  groupId: string | null;
  name: string | null;
  structureEtag: string | null;
  manifestEtag: string | null;
  sortOrder: number | null;
  contentCount: number;
  position: { current: number; total: number } | null;
}

export interface GroupEtags {
  structureEtag: string;
  manifestEtag: string;
}

@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService
  ) {}

  // ── etag ──────────────────────────────────────────────────

  /** content_etag 覆盖单帧摘要；structure_etag 只覆盖顺序/增删；manifest_etag 覆盖完整 manifest。 */
  async recomputeManifestEtag(
    groupId: string,
    client?: Prisma.TransactionClient | PrismaService
  ): Promise<string> {
    const etags = await this.recomputeGroupEtags(groupId, client);
    return etags.manifestEtag;
  }

  async recomputeGroupEtags(
    groupId: string,
    client?: Prisma.TransactionClient | PrismaService
  ): Promise<GroupEtags> {
    if (!client) {
      return this.prisma.$transaction((tx) => this.recomputeGroupEtags(groupId, tx));
    }

    const group = await client.group.findUnique({
      where: { id: groupId },
      include: {
        contents: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            sortOrder: true,
            kind: true,
            dynamicType: true,
            imageEtag: true,
            imageSize: true,
            audioEtag: true,
            audioSize: true,
            audioStatus: true,
            audioSource: true,
            audioVoice: true,
            frameName: true,
            dynamicConfig: true,
            dynamicData: true,
            dynamicLastRunAt: true,
          },
        },
      },
    });
    if (!group) throw new NotFoundError(`相册 ${groupId} 不存在`);

    const contentRows = group.contents.map((content) => ({
      id: content.id,
      sortOrder: content.sortOrder,
      kind: content.kind,
      dynamicType: content.dynamicType ?? '',
      imageEtag: content.imageEtag,
      imageSize: content.imageSize,
      audioEtag: content.audioEtag ?? '',
      audioSize: content.audioSize ?? '',
      audioStatus: content.audioStatus,
      audioSource: content.audioSource ?? '',
      audioVoice: content.audioVoice ?? '',
      frameName: content.frameName ?? '',
      statusBarText: deviceStatusBarText({ ...content, renderedAt: content.dynamicLastRunAt }),
    }));
    const contentEtags = contentRows.map((content) => ({
      id: content.id,
      etag: hashParts([
        'content',
        content.id,
        content.sortOrder,
        content.kind,
        content.dynamicType,
        content.imageEtag,
        content.imageSize,
        content.audioEtag,
        content.audioSize,
        content.audioStatus,
        content.audioSource,
        content.audioVoice,
        content.frameName,
        content.statusBarText,
      ]),
    }));
    const structureEtag = hashParts([
      'structure',
      ...contentRows.map((content) =>
        [content.id, content.sortOrder, content.kind, content.dynamicType].join(':')
      ),
    ]);
    const manifestEtag = hashParts([
      'manifest',
      group.name,
      group.sortOrder,
      structureEtag,
      ...contentEtags.map((content) => `${content.id}:${content.etag}`),
    ]);

    await bulkSetContentEtags(client, contentEtags);
    await client.group.update({
      where: { id: groupId },
      data: { structureEtag, manifestEtag },
    });
    return { structureEtag, manifestEtag };
  }

  // ── 设备 cycle / select / describe ─────────────────────────

  async listOwnerGroups(
    ownerUserId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ): Promise<GroupListEntry[]> {
    return client.group.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        structureEtag: true,
        manifestEtag: true,
        sortOrder: true,
        _count: { select: { contents: true } },
      },
    });
  }

  async setDeviceGroup(deviceId: string, gid: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { ownerUserId: true },
    });
    if (!device) throw new NotFoundError(`设备 ${deviceId} 不存在`);
    if (!device.ownerUserId) {
      throw new ForbiddenError('未绑定设备无法分配相册', {
        code: 'device_not_owned',
      });
    }

    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!group || group.ownerUserId !== device.ownerUserId) {
      throw new ForbiddenError('所选相册不属于该设备的拥有者', {
        code: 'group_not_in_scope',
      });
    }

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { selectedGroupId: gid },
    });
  }

  async cycleDeviceGroup(deviceId: string, direction: 'next' | 'prev'): Promise<CycleResult> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { ownerUserId: true, selectedGroupId: true },
    });
    if (!device) throw new NotFoundError(`设备 ${deviceId} 不存在`);
    if (!device.ownerUserId) return emptyCycle();

    const groups = await this.listOwnerGroups(device.ownerUserId);
    if (groups.length === 0) return emptyCycle();

    const curIdx = device.selectedGroupId
      ? groups.findIndex((g) => g.id === device.selectedGroupId)
      : -1;
    const nextIdx =
      curIdx < 0
        ? direction === 'next'
          ? 0
          : groups.length - 1
        : (curIdx + (direction === 'next' ? 1 : -1) + groups.length) % groups.length;
    const target = groups[nextIdx]!;

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { selectedGroupId: target.id },
    });

    return {
      groupId: target.id,
      name: target.name,
      structureEtag: target.structureEtag,
      manifestEtag: target.manifestEtag,
      sortOrder: target.sortOrder,
      contentCount: target._count.contents,
      position: { current: nextIdx + 1, total: groups.length },
    };
  }

  async describeDeviceGroup(deviceId: string): Promise<CycleResult> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { ownerUserId: true, selectedGroupId: true },
    });
    if (!device) throw new NotFoundError(`设备 ${deviceId} 不存在`);
    if (!device.ownerUserId || !device.selectedGroupId) return emptyCycle();

    const groups = await this.listOwnerGroups(device.ownerUserId);
    const idx = groups.findIndex((g) => g.id === device.selectedGroupId);
    if (idx < 0) return emptyCycle();
    const g = groups[idx]!;
    return {
      groupId: g.id,
      name: g.name,
      structureEtag: g.structureEtag,
      manifestEtag: g.manifestEtag,
      sortOrder: g.sortOrder,
      contentCount: g._count.contents,
      position: { current: idx + 1, total: groups.length },
    };
  }

  // ── Web CRUD ──────────────────────────────────────────────

  async listForOwner(ownerUserId: string): Promise<GroupSummaryT[]> {
    const groups = await this.prisma.group.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        structureEtag: true,
        manifestEtag: true,
        sortOrder: true,
        _count: { select: { contents: true } },
      },
    });
    const sizeMap = await this.aggregateBytes(groups.map((g) => g.id));
    return groups.map((g) => toSummary(g, sizeMap.get(g.id) ?? 0));
  }

  async getOwned(gid: string, ownerUserId: string): Promise<GroupSummaryT> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        structureEtag: true,
        manifestEtag: true,
        sortOrder: true,
        _count: { select: { contents: true } },
      },
    });
    if (!g || g.ownerUserId !== ownerUserId) {
      throw new NotFoundError('相册不存在');
    }
    const sizeMap = await this.aggregateBytes([gid]);
    return toSummary(g, sizeMap.get(gid) ?? 0);
  }

  async create(ownerUserId: string, body: { name: string }): Promise<GroupSummaryT> {
    const created = await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, ownerUserId);
      const sortOrder = await this.nextGroupSortOrder(ownerUserId, tx);
      const group = await tx.group.create({
        data: {
          name: body.name,
          structureEtag: 'empty',
          manifestEtag: 'empty',
          ownerUserId,
          sortOrder,
        },
        include: { _count: { select: { contents: true } } },
      });

      // 反向自动绑定：这是 owner 的第一个相册时，把所有 selectedGroupId=null 的已绑设备都指过来。
      // 配合 claim 时的「已有相册则自动绑第一个」，新用户全程不需要再去设备详情手动「分配相册」。
      // 仅在 count==1 时触发，避免后续创建相册时覆盖用户主动留空的设备。
      const groupCount = await tx.group.count({ where: { ownerUserId } });
      if (groupCount === 1) {
        const result = await tx.device.updateMany({
          where: { ownerUserId, selectedGroupId: null },
          data: { selectedGroupId: group.id },
        });
        if (result.count > 0) {
          this.logger.log(
            `first group ${group.id} created → auto-bound ${result.count} pending device(s)`
          );
        }
      }
      return group;
    });
    return toSummary(created, 0);
  }

  async update(gid: string, ownerUserId: string, body: { name?: string }): Promise<GroupSummaryT> {
    // 校验 + 更新 + recomputeManifestEtag 收进同一事务；name 没变直接跳过 update。
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.group.findUnique({
        where: { id: gid },
        select: { ownerUserId: true, name: true },
      });
      if (!g || g.ownerUserId !== ownerUserId) {
        throw new NotFoundError('相册不存在');
      }
      if (body.name === undefined || body.name === g.name) return;
      await tx.group.update({ where: { id: gid }, data: { name: body.name } });
      await this.recomputeManifestEtag(gid, tx);
    });
    return this.getOwned(gid, ownerUserId);
  }

  async delete(gid: string, ownerUserId: string): Promise<void> {
    const g = await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, ownerUserId);
      const group = await tx.group.findUnique({
        where: { id: gid },
        include: {
          contents: { select: { id: true, audioEtag: true } },
        },
      });
      if (!group || group.ownerUserId !== ownerUserId) {
        throw new NotFoundError('相册不存在');
      }
      await tx.group.delete({ where: { id: gid } });
      return group;
    });
    const deleted = await Promise.allSettled(
      g.contents.flatMap((content) => {
        return [
          this.blob.delete(gid, content.id, 'image'),
          content.audioEtag
            ? this.blob.delete(gid, audioBlobContentId(content.id, content.audioEtag), 'audio')
            : Promise.resolve(),
        ];
      })
    );
    const failed = deleted.filter((result) => result.status === 'rejected').length;
    if (failed > 0) this.logger.warn(`group ${gid} deleted with ${failed} blob cleanup failure(s)`);
  }

  async nextGroupSortOrder(
    ownerUserId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ): Promise<number> {
    const top = await client.group.findFirst({
      where: { ownerUserId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (top?.sortOrder ?? -1) + 1;
  }

  async reorderGroups(ownerUserId: string, order: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, ownerUserId);
      const owned = await tx.group.findMany({
        where: { ownerUserId },
        select: { id: true, sortOrder: true },
      });
      const sortOrderById = new Map(owned.map((g) => [g.id, g.sortOrder]));
      const orderSet = new Set(order);
      if (
        order.length !== sortOrderById.size ||
        orderSet.size !== order.length ||
        !order.every((id) => sortOrderById.has(id))
      ) {
        throw new ValidationError('排序列表须包含所有相册且不重复', {
          code: 'order_mismatch',
        });
      }
      // manifestEtag 包含 group.sortOrder，所以只为位置真正变化的 group 重算；位置没动的跳过，
      // 避免 reorder 1 个 group 时把所有 group 的 manifest 都刷一遍（每次刷会扫该 group 全部 content）。
      const changed = order.filter((id, idx) => sortOrderById.get(id) !== idx);
      if (changed.length === 0) return;
      await bulkSetGroupSortOrder(tx, ownerUserId, order);
      for (const groupId of changed) {
        await this.recomputeManifestEtag(groupId, tx);
      }
    });
  }

  // ── 内部 helpers ──────────────────────────────────────────

  private async aggregateBytes(groupIds: string[]): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.prisma.content.groupBy({
      by: ['groupId'],
      where: { groupId: { in: groupIds } },
      _sum: { imageSize: true, audioSize: true },
    });
    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.groupId, (row._sum.imageSize ?? 0) + (row._sum.audioSize ?? 0));
    }
    return result;
  }

  async assertOwned(gid: string, ownerUserId: string): Promise<void> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!g || g.ownerUserId !== ownerUserId) {
      throw new NotFoundError('相册不存在');
    }
  }
}

function emptyCycle(): CycleResult {
  return {
    groupId: null,
    name: null,
    structureEtag: null,
    manifestEtag: null,
    sortOrder: null,
    contentCount: 0,
    position: null,
  };
}

function toSummary(
  g: {
    id: string;
    name: string;
    structureEtag: string;
    manifestEtag: string;
    sortOrder: number;
    _count: { contents: number };
  },
  totalBytes: number
): GroupSummaryT {
  return {
    id: g.id,
    name: g.name,
    structure_etag: g.structureEtag,
    manifest_etag: g.manifestEtag,
    sort_order: g.sortOrder,
    content_count: g._count.contents,
    total_bytes: totalBytes,
  };
}

function hashParts(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

async function bulkSetContentEtags(
  client: Prisma.TransactionClient | PrismaService,
  updates: Array<{ id: string; etag: string }>
): Promise<void> {
  if (updates.length === 0) return;
  const ids = Prisma.join(updates.map((update) => update.id));
  await client.$executeRaw`
    UPDATE \`contents\`
    SET \`content_etag\` = CASE \`id\`
      ${Prisma.join(
        updates.map((update) => Prisma.sql`WHEN ${update.id} THEN ${update.etag}`),
        ' '
      )}
    END
    WHERE \`id\` IN (${ids})
  `;
}
