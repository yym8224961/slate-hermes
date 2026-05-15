import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { DeviceStateT, DeviceSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { GroupsService, type CycleResult } from '../groups/groups.service';

export interface TelemetryInput {
  battery_pct?: number;
  rssi_dbm?: number;
  fw_version?: string;
  current_group?: string | null;
  current_content_seq?: number;
  free_heap?: number;
  fw_build_ts?: string;
}

// toSummary 只需要 admin 端要展示的字段，pairCode/secretHash 不在其中。
// 用结构子集而非 Prisma `Device` 类型，让 toSummary 既能吃 findMany 全字段返回，
// 也能吃 select 投影后的对象。
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

// 配对码字母表去掉视觉易混的 0/O/1/I/L，降低用户对屏抄码出错率。
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService
  ) {}

  // ── 注册 / telemetry ────────────────────────────────────────

  // 无鉴权路由唯一行为：固件 NVS 没 secret 时调一次。
  // 同 mac 二次进来一律走 reset 路径（清 owner、清相册、轮换 secret + pair_code）。
  // 这是「物理控制权 = 数字所有权」的实现锚点：谁持有设备能工厂重置，谁就能重新拿走。
  async registerOrReset(mac: string): Promise<{
    deviceId: string;
    deviceSecret: string; // 明文，仅本次返回，落库只存 sha256
    pairCode: string;
    reclaimed: boolean;
    serverTime: string;
  }> {
    const secret = generateSecret();
    const secretHash = hashSecret(secret);
    const pairCode = await this.generateUniquePairCode();

    const existing = await this.prisma.device.findUnique({
      where: { mac },
      select: { id: true, ownerUserId: true },
    });

    let deviceId: string;
    let reclaimed: boolean;
    if (existing) {
      await this.prisma.device.update({
        where: { mac },
        data: {
          secretHash,
          pairCode,
          ownerUserId: null,
          selectedGroupId: null,
        },
      });
      deviceId = existing.id;
      reclaimed = existing.ownerUserId !== null;
      this.logger.log(
        reclaimed
          ? `device reclaimed (physical reset): mac=${mac} id=${deviceId} prev_owner=${existing.ownerUserId}`
          : `device re-registered (was unowned): mac=${mac} id=${deviceId}`
      );
    } else {
      const created = await this.prisma.device.create({
        data: { mac, secretHash, pairCode },
        select: { id: true },
      });
      deviceId = created.id;
      reclaimed = false;
      this.logger.log(`device first registered: mac=${mac} id=${deviceId}`);
    }

    return {
      deviceId,
      deviceSecret: secret,
      pairCode,
      reclaimed,
      serverTime: new Date().toISOString(),
    };
  }

  // DeviceAuthGuard 用：Bearer secret → 找对应 device（sha256 比对）。
  async findDeviceIdBySecret(secret: string): Promise<string | null> {
    const hash = hashSecret(secret);
    const row = await this.prisma.device.findFirst({
      where: { secretHash: hash },
      select: { id: true },
    });
    return row?.id ?? null;
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
        select: { id: true, mac: true, name: true, ownerUserId: true, pairCode: true },
      }),
      cached?.group !== undefined
        ? Promise.resolve(cached.group)
        : this.groups.describeDeviceGroup(deviceId),
    ]);
    if (!device) {
      throw new NotFoundError(`device ${deviceId} disappeared mid-request`);
    }

    const bound = device.ownerUserId !== null;
    return {
      device: {
        id: device.id,
        mac: device.mac,
        name: device.name,
        bound,
        // 已绑定不返回 pair_code，避免冗余暴露（已绑定的码也无法被再次 claim，但守住「最小披露」）。
        pair_code: bound ? null : device.pairCode,
        server_time: new Date().toISOString(),
      },
      group: resolvedGroup.groupId
        ? {
            id: resolvedGroup.groupId,
            etag: resolvedGroup.etag!,
            name: resolvedGroup.name!,
            content_count: resolvedGroup.contentCount,
            sort_order: resolvedGroup.sortOrder!,
            position: resolvedGroup.position!,
          }
        : null,
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

  async claimByPairCode(code: string, ownerUserId: string): Promise<DeviceSummaryT> {
    const device = await this.prisma.device.findUnique({ where: { pairCode: code } });
    if (!device) {
      throw new NotFoundError('配对码无效', { code: 'pair_code_invalid' });
    }
    if (device.ownerUserId) {
      // 设计上 claim 后会立即轮换 pairCode，理论上同 code 不会查到 owned device。
      // 保险起见显式拒绝，避免攻击者用早期截图的码反复尝试（虽然本来就查不到）。
      if (device.ownerUserId === ownerUserId) {
        return toSummary(device);
      }
      throw new ForbiddenError('设备已被他人绑定', {
        code: 'already_owned_by_other_user',
      });
    }
    const [sortOrder, newPairCode, ownerGroups] = await Promise.all([
      this.nextDeviceSortOrder(ownerUserId),
      this.generateUniquePairCode(),
      this.groups.listOwnerGroups(ownerUserId),
    ]);
    // owner 已有相册时，自动选第一个（按 sortOrder），省去 web 端「再去设备详情手动选」二次操作。
    // owner 0 个相册时 selectedGroupId 保持 null，设备 splash 提示「请先创建相册」；
    // 之后 owner 首次创建相册会触发 GroupsService.create 里的反向绑定，设备自动进 FrameScene。
    const selectedGroupId = ownerGroups[0]?.id ?? null;
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { ownerUserId, sortOrder, pairCode: newPairCode, selectedGroupId },
    });
    this.logger.log(
      `device claimed by pair code: id=${device.id} owner=${ownerUserId}` +
        (selectedGroupId ? ` auto-bound to group ${selectedGroupId}` : ' (owner has no group yet)')
    );
    return toSummary(updated);
  }

  async unbind(deviceId: string, ownerUserId: string): Promise<void> {
    await this.requireOwned(deviceId, ownerUserId);
    // 解绑同时轮换 pair_code，防截图泄漏的旧码被人立即抢 claim。
    // secret 不轮换：让设备 poll 看到 owner=null 自然 emit kUnbound 切回 splash 显示新码，
    // 不强制 401 重启，体验更顺。攻击者拿过 secret 还能继续看 unowned 状态，但要 claim
    // 仍需在用户之前用新 pair_code，并且自己得有 Web 账号。
    const newPairCode = await this.generateUniquePairCode();
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        ownerUserId: null,
        selectedGroupId: null,
        pairCode: newPairCode,
      },
    });
    this.logger.log(`device unbound: id=${deviceId} new_pair_code=${newPairCode}`);
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
      throw new ValidationError('排序列表须包含所有设备且不重复', {
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

  private async nextDeviceSortOrder(ownerUserId: string): Promise<number> {
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
      throw new NotFoundError('设备不存在');
    }
    return d as DeviceRow;
  }

  // 6 位 [A-Z2-9] 字母表（避开 0/O/1/I/L）。PAIR_CODE_ALPHABET.length^6 ≈ 8.8 亿，撞概率极低，
  // 但仍按 unique 约束最多重试 8 次以兜底。
  private async generateUniquePairCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const bytes = randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += PAIR_CODE_ALPHABET[bytes[i]! % PAIR_CODE_ALPHABET.length];
      }
      const exists = await this.prisma.device.findUnique({
        where: { pairCode: code },
        select: { id: true },
      });
      if (!exists) return code;
    }
    throw new Error('failed to generate unique pair code after 8 attempts');
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

// secret = 32B 随机熵 hex 编码（64 字符），设备 NVS 持久化，DB 只存 sha256(secret) 比对。
function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
