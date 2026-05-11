import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GroupSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';

interface GroupListEntry {
  id: string;
  etag: string;
  sortOrder: number;
  _count: { frames: number };
}

export interface CycleResult {
  groupId: string | null;
  etag: string | null;
  sortOrder: number | null;
  frameCount: number;
  position: { current: number; total: number } | null;
}

@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService
  ) {}

  // ── etag ──────────────────────────────────────────────────

  /**
   * etag = sha256(group_name + sorted(sortOrder + image_etag + audio_etag + caption).join('|')).slice(0,32)
   * 任意 frame / caption 改了都会 bump。
   */
  async recomputeGroupEtag(groupId: string): Promise<string> {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        frames: {
          orderBy: { sortOrder: 'asc' },
          select: {
            sortOrder: true,
            imageEtag: true,
            audioEtag: true,
            caption: true,
          },
        },
      },
    });
    if (!group) throw new NotFoundError(`相册 ${groupId} 不存在`);

    const parts = [
      group.name,
      ...group.frames.map(
        (f) => `${f.sortOrder}:${f.imageEtag}:${f.audioEtag ?? ''}:${f.caption ?? ''}`
      ),
    ];
    const etag = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
    await this.prisma.group.update({ where: { id: groupId }, data: { etag } });
    return etag;
  }

  // ── 设备 cycle / select / describe ─────────────────────────

  async listOwnerGroups(ownerUserId: string | null): Promise<GroupListEntry[]> {
    return this.prisma.group.findMany({
      where: { ownerUserId: ownerUserId ?? undefined },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        etag: true,
        sortOrder: true,
        _count: { select: { frames: true } },
      },
    });
  }

  async setDeviceGroup(deviceId: string, gid: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { ownerUserId: true },
    });
    if (!device) throw new NotFoundError(`设备 ${deviceId} 不存在`);

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
      etag: target.etag,
      sortOrder: target.sortOrder,
      frameCount: target._count.frames,
      position: { current: nextIdx + 1, total: groups.length },
    };
  }

  async describeDeviceGroup(deviceId: string): Promise<CycleResult> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { ownerUserId: true, selectedGroupId: true },
    });
    if (!device) throw new NotFoundError(`设备 ${deviceId} 不存在`);
    if (!device.selectedGroupId) return emptyCycle();

    const groups = await this.listOwnerGroups(device.ownerUserId);
    const idx = groups.findIndex((g) => g.id === device.selectedGroupId);
    if (idx < 0) return emptyCycle();
    const g = groups[idx]!;
    return {
      groupId: g.id,
      etag: g.etag,
      sortOrder: g.sortOrder,
      frameCount: g._count.frames,
      position: { current: idx + 1, total: groups.length },
    };
  }

  // ── Web CRUD ──────────────────────────────────────────────

  async listForOwner(ownerUserId: string): Promise<GroupSummaryT[]> {
    const groups = await this.prisma.group.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { frames: true } },
        frames: { select: { imageSize: true, audioSize: true } },
      },
    });
    return groups.map((g) => {
      const totalBytes = g.frames.reduce(
        (sum, f) => sum + (f.imageSize ?? 0) + (f.audioSize ?? 0),
        0
      );
      return toSummary(g, totalBytes);
    });
  }

  async getOwned(gid: string, ownerUserId: string): Promise<GroupSummaryT> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      include: { _count: { select: { frames: true } } },
    });
    if (!g || g.ownerUserId !== ownerUserId) {
      throw new NotFoundError('相册不存在');
    }
    const sizeMap = await this.aggregateBytes([gid]);
    return toSummary(g, sizeMap.get(gid) ?? 0);
  }

  async create(ownerUserId: string, body: { name: string }): Promise<GroupSummaryT> {
    const sortOrder = await this.nextGroupSortOrder(ownerUserId);
    const created = await this.prisma.group.create({
      data: {
        name: body.name,
        etag: 'empty',
        ownerUserId,
        sortOrder,
      },
      include: { _count: { select: { frames: true } } },
    });
    // 反向自动绑定：这是 owner 的第一个相册时，把所有 selectedGroupId=null 的已绑设备都指过来。
    // 配合 claim 时的「已有相册则自动绑第一个」，新用户全程不需要再去设备详情手动「分配相册」。
    // 仅在 count==1 时触发，避免后续创建相册时覆盖用户主动留空的设备。
    const groupCount = await this.prisma.group.count({ where: { ownerUserId } });
    if (groupCount === 1) {
      const result = await this.prisma.device.updateMany({
        where: { ownerUserId, selectedGroupId: null },
        data: { selectedGroupId: created.id },
      });
      if (result.count > 0) {
        this.logger.log(
          `first group ${created.id} created → auto-bound ${result.count} pending device(s)`
        );
      }
    }
    return toSummary(created, 0);
  }

  async update(
    gid: string,
    ownerUserId: string,
    body: { name?: string; sort_order?: number }
  ): Promise<void> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true, name: true },
    });
    if (!g || g.ownerUserId !== ownerUserId) {
      throw new NotFoundError('相册不存在');
    }
    const data: { name?: string; sortOrder?: number } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.sort_order !== undefined) data.sortOrder = body.sort_order;
    if (Object.keys(data).length === 0) return;
    await this.prisma.group.update({ where: { id: gid }, data });
    if (data.name !== undefined && data.name !== g.name) {
      await this.recomputeGroupEtag(gid);
    }
  }

  async delete(gid: string, ownerUserId: string): Promise<void> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      include: {
        frames: { select: { id: true, audioEtag: true } },
      },
    });
    if (!g || g.ownerUserId !== ownerUserId) {
      throw new NotFoundError('相册不存在');
    }
    await Promise.all(
      g.frames.flatMap((f) => {
        const ops = [this.blob.delete(gid, f.id, 'image')];
        if (f.audioEtag !== null) ops.push(this.blob.delete(gid, f.id, 'audio'));
        return ops;
      })
    );
    await this.prisma.group.delete({ where: { id: gid } });
  }

  async nextGroupSortOrder(ownerUserId: string): Promise<number> {
    const top = await this.prisma.group.findFirst({
      where: { ownerUserId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (top?.sortOrder ?? -1) + 1;
  }

  async reorderGroups(ownerUserId: string, order: string[]): Promise<void> {
    const owned = await this.prisma.group.findMany({
      where: { ownerUserId },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((g) => g.id));
    const orderSet = new Set(order);
    if (
      order.length !== ownedSet.size ||
      orderSet.size !== order.length ||
      !order.every((id) => ownedSet.has(id))
    ) {
      throw new ValidationError('排序列表须包含所有相册且不重复', {
        code: 'order_mismatch',
      });
    }

    await this.prisma.$transaction([
      ...order.map((id, idx) =>
        this.prisma.group.update({
          where: { id },
          data: { sortOrder: -(idx + 1) },
        })
      ),
      ...order.map((id, idx) =>
        this.prisma.group.update({
          where: { id },
          data: { sortOrder: idx },
        })
      ),
    ]);
  }

  // ── 内部 helpers ──────────────────────────────────────────

  private async aggregateBytes(groupIds: string[]): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();
    const sums = await this.prisma.frame.groupBy({
      by: ['groupId'],
      where: { groupId: { in: groupIds } },
      _sum: { imageSize: true, audioSize: true },
    });
    return new Map(sums.map((s) => [s.groupId, (s._sum.imageSize ?? 0) + (s._sum.audioSize ?? 0)]));
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
    etag: null,
    sortOrder: null,
    frameCount: 0,
    position: null,
  };
}

function toSummary(
  g: {
    id: string;
    name: string;
    etag: string;
    sortOrder: number;
    _count: { frames: number };
  },
  totalBytes: number
): GroupSummaryT {
  return {
    id: g.id,
    name: g.name,
    etag: g.etag,
    sort_order: g.sortOrder,
    frame_count: g._count.frames,
    total_bytes: totalBytes,
  };
}
