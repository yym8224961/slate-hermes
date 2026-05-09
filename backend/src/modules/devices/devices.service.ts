import { Injectable, Logger } from '@nestjs/common';
import type { DeviceStateT, DeviceSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AppConfig } from '../../infra/config/app.config';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { GroupsService, type CycleResult } from '../groups/groups.service';

export interface TelemetryInput {
  battery_pct?: number;
  rssi_dbm?: number;
  fw_version?: string;
  current_group?: string | null;
  current_frame_seq?: number;
  free_heap?: number;
  fw_build_ts?: string;
}

interface DeviceRow {
  id: string;
  mac: string;
  name: string | null;
  selectedGroupId: string | null;
  lastSeenAt: Date | null;
  batteryPct: number | null;
  rssiDbm: number | null;
  fwVersion: string | null;
  ownerUserId: string | null;
  sortOrder: number;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly groups: GroupsService
  ) {}

  // ── 注册 / telemetry ────────────────────────────────────────

  async claimDevice(
    mac: string,
    name?: string
  ): Promise<{ deviceId: string; reclaimed: boolean; serverTime: string }> {
    const upserted = await this.prisma.device.upsert({
      where: { mac },
      update: {}, // 已注册时不动
      create: { mac, ...(name ? { name } : {}) },
      select: { id: true, createdAt: true },
    });
    const reclaimed = Date.now() - upserted.createdAt.getTime() > 1000;
    if (reclaimed) {
      this.logger.log(`device re-register (no-op): mac=${mac} id=${upserted.id}`);
    } else {
      this.logger.log(`device registered: mac=${mac} id=${upserted.id} name=${name ?? '<none>'}`);
    }
    return {
      deviceId: upserted.id,
      reclaimed,
      serverTime: new Date().toISOString(),
    };
  }

  async recordTelemetry(deviceId: string, t: TelemetryInput | undefined): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        ...(t?.battery_pct !== undefined ? { batteryPct: t.battery_pct } : {}),
        ...(t?.rssi_dbm !== undefined ? { rssiDbm: t.rssi_dbm } : {}),
        ...(t?.fw_version !== undefined ? { fwVersion: t.fw_version } : {}),
      },
    });
  }

  // ── poll/cycle 共用：build 当前 DeviceState ────────────────

  async buildState(deviceId: string, cached?: { group?: CycleResult }): Promise<DeviceStateT> {
    const [device, resolvedGroup] = await Promise.all([
      this.prisma.device.findUnique({
        where: { id: deviceId },
        select: { id: true, mac: true, name: true },
      }),
      cached?.group !== undefined
        ? Promise.resolve(cached.group)
        : this.groups.describeDeviceGroup(deviceId),
    ]);
    if (!device) {
      throw new NotFoundError(`device ${deviceId} disappeared mid-request`);
    }

    return {
      device: {
        id: device.id,
        mac: device.mac,
        name: device.name,
        server_time: new Date().toISOString(),
      },
      group: resolvedGroup.groupId
        ? {
            id: resolvedGroup.groupId,
            etag: resolvedGroup.etag!,
            frame_count: resolvedGroup.frameCount,
            default_frame_seq: 0,
            sort_order: resolvedGroup.sortOrder!,
            position: resolvedGroup.position!,
          }
        : null,
      poll_interval_s: this.config.devicePollIntervalSec,
    };
  }

  // ── admin 端业务 ────────────────────────────────────────────

  async listForOwner(ownerUserId: string): Promise<DeviceSummaryT[]> {
    const rows = await this.prisma.device.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toSummary);
  }

  async listUnowned(): Promise<DeviceSummaryT[]> {
    const rows = await this.prisma.device.findMany({
      where: { ownerUserId: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSummary);
  }

  async getOwned(deviceId: string, ownerUserId: string): Promise<DeviceSummaryT> {
    const d = await this.requireOwned(deviceId, ownerUserId);
    return toSummary(d);
  }

  async patchDevice(
    deviceId: string,
    ownerUserId: string,
    body: { name?: string; selected_group_id?: string | null }
  ): Promise<void> {
    await this.requireOwned(deviceId, ownerUserId);
    if (body.name !== undefined) {
      await this.prisma.device.update({
        where: { id: deviceId },
        data: { name: body.name },
      });
    }
    if (body.selected_group_id !== undefined) {
      if (body.selected_group_id === null) {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: { selectedGroupId: null },
        });
      } else {
        await this.groups.setDeviceGroup(deviceId, body.selected_group_id);
      }
    }
  }

  async claimByDeviceId(deviceId: string, ownerUserId: string): Promise<DeviceSummaryT> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundError(`device ${deviceId} not found`);
    if (device.ownerUserId && device.ownerUserId !== ownerUserId) {
      throw new ForbiddenError('already owned by other user', {
        code: 'already_owned_by_other_user',
      });
    }
    const sortOrder =
      device.ownerUserId === ownerUserId
        ? device.sortOrder
        : await this.nextDeviceSortOrder(ownerUserId);
    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: { ownerUserId, sortOrder },
    });
    return toSummary(updated);
  }

  async claimByMac(
    mac: string,
    ownerUserId: string,
    name?: string
  ): Promise<{ summary: DeviceSummaryT; created: boolean }> {
    const existing = await this.prisma.device.findUnique({ where: { mac } });
    if (existing) {
      if (existing.ownerUserId && existing.ownerUserId !== ownerUserId) {
        throw new ForbiddenError('already owned by other user', {
          code: 'already_owned_by_other_user',
        });
      }
      const sortOrder =
        existing.ownerUserId === ownerUserId
          ? existing.sortOrder
          : await this.nextDeviceSortOrder(ownerUserId);
      const updated = await this.prisma.device.update({
        where: { id: existing.id },
        data: {
          ownerUserId,
          sortOrder,
          ...(name !== undefined ? { name } : {}),
        },
      });
      return { summary: toSummary(updated), created: false };
    }
    const sortOrder = await this.nextDeviceSortOrder(ownerUserId);
    const created = await this.prisma.device.create({
      data: { mac, name: name ?? null, ownerUserId, sortOrder },
    });
    return { summary: toSummary(created), created: true };
  }

  async unbind(deviceId: string, ownerUserId: string): Promise<void> {
    await this.requireOwned(deviceId, ownerUserId);
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { ownerUserId: null, selectedGroupId: null },
    });
  }

  async reorderDevices(ownerUserId: string, order: string[]): Promise<void> {
    const owned = await this.prisma.device.findMany({
      where: { ownerUserId },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((d) => d.id));
    const orderSet = new Set(order);
    if (
      order.length !== ownedSet.size ||
      orderSet.size !== order.length ||
      !order.every((id) => ownedSet.has(id))
    ) {
      throw new ValidationError('order must list every owned device exactly once', {
        code: 'order_mismatch',
      });
    }

    await this.prisma.$transaction([
      ...order.map((id, idx) =>
        this.prisma.device.update({
          where: { id },
          data: { sortOrder: -(idx + 1) },
        })
      ),
      ...order.map((id, idx) =>
        this.prisma.device.update({
          where: { id },
          data: { sortOrder: idx },
        })
      ),
    ]);
  }

  // ── 内部 helpers ────────────────────────────────────────────

  async nextDeviceSortOrder(ownerUserId: string): Promise<number> {
    const last = await this.prisma.device.findFirst({
      where: { ownerUserId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  private async requireOwned(deviceId: string, ownerUserId: string): Promise<DeviceRow> {
    const d = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!d || d.ownerUserId !== ownerUserId) {
      throw new NotFoundError('device not found');
    }
    return d as DeviceRow;
  }
}

export function toSummary(d: DeviceRow): DeviceSummaryT {
  return {
    id: d.id,
    mac: d.mac,
    name: d.name,
    selected_group_id: d.selectedGroupId,
    last_seen_at: d.lastSeenAt?.toISOString() ?? null,
    battery_pct: d.batteryPct,
    rssi_dbm: d.rssiDbm,
    fw_version: d.fwVersion,
    owner_user_id: d.ownerUserId,
    sort_order: d.sortOrder,
  };
}
