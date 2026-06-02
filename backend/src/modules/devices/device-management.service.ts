import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DeviceSummaryT } from 'shared';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { lockUserRow } from '../../common/db/row-locks';
import { bulkSetDeviceSortOrder } from '../../common/db/bulk-sort-order';
import { validateOrderSet } from '../../common/db/order-validation';
import { nextDeviceSortOrder } from '../../common/db/sort-order';
import { prismaUniqueTargetIncludes } from '../../common/db/prisma-utils';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { GroupsService } from '../groups/groups.service';
import {
  DEVICE_CLAIM_SELECT,
  DEVICE_SUMMARY_SELECT,
  type DeviceRow,
  toDeviceSummary,
} from './device-types';
import { PairCodeService } from './pair-code.service';

@Injectable()
export class DeviceManagementService {
  private readonly logger = new Logger(DeviceManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService,
    private readonly pairCodes: PairCodeService
  ) {}

  async listForOwner(ownerUserId: string): Promise<DeviceSummaryT[]> {
    const rows = await this.prisma.device.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: DEVICE_SUMMARY_SELECT,
    });
    return rows.map(toDeviceSummary);
  }

  async getOwned(deviceId: string, ownerUserId: string): Promise<DeviceSummaryT> {
    const d = await this.requireOwned(deviceId, ownerUserId);
    return toDeviceSummary(d);
  }

  async patchDevice(
    deviceId: string,
    ownerUserId: string,
    body: { name?: string; selected_group_id?: string | null }
  ): Promise<void> {
    await this.requireOwned(deviceId, ownerUserId);
    const data: { name?: string; selectedGroupId?: string | null } = {};
    if (body.name !== undefined) {
      data.name = body.name;
    }
    if (body.selected_group_id !== undefined) {
      if (body.selected_group_id === null) {
        data.selectedGroupId = null;
      } else {
        await this.groups.assertOwned(body.selected_group_id, ownerUserId);
        data.selectedGroupId = body.selected_group_id;
      }
    }
    if (Object.keys(data).length === 0) return;
    const updated = await this.prisma.device.updateMany({
      where: { id: deviceId, ownerUserId },
      data,
    });
    if (updated.count !== 1) throw new NotFoundError('设备不存在');
  }

  async claimByPairCode(code: string, ownerUserId: string): Promise<DeviceSummaryT> {
    // 查询和 CAS 更新放进同一事务；真正的并发保护由 update where ownerUserId:null 保证。
    const result = await this.prisma
      .$transaction(async (tx): Promise<{ device: DeviceRow; freshlyClaimed: boolean }> => {
        const device = await tx.device.findUnique({
          where: { pairCode: code },
          select: DEVICE_CLAIM_SELECT,
        });
        if (!device) {
          throw new NotFoundError('配对码无效', { code: 'pair_code_invalid' });
        }
        if (device.ownerUserId) {
          if (device.ownerUserId === ownerUserId) {
            return { device, freshlyClaimed: false };
          }
          throw new ForbiddenError('设备已被他人绑定', {
            code: 'already_owned_by_other_user',
          });
        }

        await lockUserRow(tx, ownerUserId);
        const sortOrder = await nextDeviceSortOrder(tx, ownerUserId);
        const newPairCode = await this.pairCodes.generateUniquePairCode(tx);
        const ownerGroups = await this.groups.listOwnerGroups(ownerUserId, tx);
        const selectedGroupId = ownerGroups[0]?.id ?? null;

        // ownerUserId: null 当 CAS 用：另一个事务抢先 update 后 P2025 抛出走 conflict。
        const updated = await tx.device.update({
          where: { id: device.id, ownerUserId: null },
          data: { ownerUserId, sortOrder, pairCode: newPairCode, selectedGroupId },
          select: DEVICE_SUMMARY_SELECT,
        });
        return { device: updated, freshlyClaimed: true };
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError) {
          // P2025: CAS 落空 —— 另一个事务已抢占。
          // P2002: 极小概率两并发事务生成同一新 pairCode。
          if (err.code === 'P2025' || prismaUniqueTargetIncludes(err, 'pair_code')) {
            throw new ConflictError('配对码已被使用，请查看设备屏幕上的最新配对码', {
              code: 'pair_code_already_claimed',
            });
          }
          if (prismaUniqueTargetIncludes(err, 'owner_user_id', 'sort_order')) {
            throw new ConflictError('设备排序冲突，请重试', {
              code: 'device_sort_order_conflict',
            });
          }
        }
        throw err;
      });

    const { device, freshlyClaimed } = result;
    if (freshlyClaimed) {
      this.logger.log(
        `Device ${device.id} was claimed by owner ${ownerUserId}` +
          (device.selectedGroupId
            ? ` and auto-bound to group ${device.selectedGroupId}.`
            : '; the owner has no group yet.')
      );
    }
    return toDeviceSummary(device);
  }

  async unbind(deviceId: string, ownerUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findUnique({
        where: { id: deviceId },
        select: { ownerUserId: true },
      });
      if (!device || device.ownerUserId !== ownerUserId) {
        throw new NotFoundError('设备不存在');
      }
      await lockUserRow(tx, ownerUserId);
      // 解绑同时轮换 pair_code，防截图泄漏的旧码被人立即抢 claim。
      // secret 不轮换：让设备 poll 看到 owner=null 自然 emit kUnbound 切回 splash 显示新码，
      // 不强制 401 重启，体验更顺。攻击者拿过 secret 还能继续看 unowned 状态，但要 claim
      // 仍需在用户之前用新 pair_code，并且自己得有 Web 账号。
      const newPairCode = await this.pairCodes.generateUniquePairCode(tx);
      await tx.device.update({
        where: { id: deviceId },
        data: {
          ownerUserId: null,
          selectedGroupId: null,
          pairCode: newPairCode,
        },
      });
    });
    this.logger.log(`Device ${deviceId} was unbound and received a new pair code.`);
  }

  async reorderDevices(ownerUserId: string, order: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, ownerUserId);
      const owned = await tx.device.findMany({
        where: { ownerUserId },
        select: { id: true },
      });
      validateOrderSet(
        owned.map((d) => d.id),
        order,
        {
          duplicateMessage: '排序列表不能包含重复设备',
          duplicateCode: 'order_duplicate',
          unknownMessage: '排序列表包含不属于当前用户的设备',
          unknownCode: 'order_unknown_device',
          missingMessage: '排序列表须包含所有设备',
          missingCode: 'order_missing_device',
        }
      );
      await bulkSetDeviceSortOrder(tx, ownerUserId, order);
    });
  }

  private async requireOwned(deviceId: string, ownerUserId: string): Promise<DeviceRow> {
    const d = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: DEVICE_SUMMARY_SELECT,
    });
    if (!d || d.ownerUserId !== ownerUserId) {
      throw new NotFoundError('设备不存在');
    }
    return d;
  }
}
