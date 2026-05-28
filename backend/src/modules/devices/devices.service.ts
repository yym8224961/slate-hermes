import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { DeviceStateT, DeviceSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { lockUserRow } from '../../common/db/row-locks';
import { bulkSetDeviceSortOrder } from '../../common/db/bulk-sort-order';
import type { PrismaClientLike } from '../../common/db/prisma-client-like';
import { prismaUniqueTargetIncludes } from '../../common/utils';
import {
  hashDeviceSecret,
  invalidateDeviceSecretHash,
} from '../../common/auth/device-secret-auth-cache';
import {
  GroupsService,
  type CycleResult,
  type DeviceGroupSnapshot,
} from '../groups/groups.service';

export interface TelemetryInput {
  battery_pct?: number;
  rssi_dbm?: number;
  fw_version?: string;
  wake_reason?: 'timer' | 'button' | 'power_on' | 'charge' | 'other';
  current_group?: string | null;
  current_content_seq?: number;
  current_content_etag?: string;
  manifest_etag?: string;
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

export interface DevicePollSnapshot extends DeviceGroupSnapshot {
  id: string;
  mac: string;
  name: string | null;
  ownerUserId: string | null;
  selectedGroupId: string | null;
  pairCode: string;
  selectedGroup: { manifestEtag: string } | null;
}

const DEVICE_SUMMARY_SELECT = {
  id: true,
  mac: true,
  name: true,
  selectedGroupId: true,
  lastSeenAt: true,
  batteryPct: true,
  rssiDbm: true,
  fwVersion: true,
  ownerUserId: true,
  sortOrder: true,
} as const satisfies Prisma.DeviceSelect;

const DEVICE_CLAIM_SELECT = {
  ...DEVICE_SUMMARY_SELECT,
  pairCode: true,
} as const satisfies Prisma.DeviceSelect;

// 配对码字母表去掉视觉易混的 0/O/1/I/L，降低用户对屏抄码出错率。
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_RANDOM_LIMIT =
  Math.floor(256 / PAIR_CODE_ALPHABET.length) * PAIR_CODE_ALPHABET.length;
const REGISTER_RESET_THROTTLE_MS = 60_000;

interface RegisterResetOutcome {
  deviceId: string;
  reclaimed: boolean;
  previousOwnerUserId: string | null;
  previousSecretHash: string | null;
  isFirstRegister: boolean;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: GroupsService
  ) {}

  // ── 注册 / telemetry ────────────────────────────────────────

  // 无鉴权路由唯一行为：固件 NVS 没 secret 时调一次。
  //
  // ⚠️ 设计决定（不要改）：同 mac 二次进来一律走 reset 路径，清 owner、清相册、轮换
  // secret + pair_code —— 即「物理重置即转移」语义。已知代价是 mac 可被嗅探/伪造，
  // 攻击者拿到 mac 即可夺取设备所有权；当前用户基数极小（个位数），权衡后选了可用性：
  //   - 设备 NVS 损坏、刷固件、二手转手、忘记 owner 账号密码 等场景下不会把用户锁死；
  //   - 持有者本人想换网络/重置配对，无需先登 Web 端解绑，物理控制即可。
  // 60s 节流仅用于防一次 NVS 写盘失败被放大成连续 reset 丢所有权，不是安全机制。
  //
  // 请勿"修复"成 require-unbind（已绑定就 409）：上一版试过，会把"NVS 坏掉的合法持有者"
  // 永久锁在 409 错误里，必须先能登 Web 端才能解开 —— 反而让设备失去物理控制权这条最后
  // 兜底。若未来用户量上来要堵 mac 后门，应通过物理重置 + 屏显 challenge + Web 端确认
  // 的方式重做，而不是简单拒绝 mac-only 注册。
  async registerOrReset(mac: string): Promise<{
    deviceId: string;
    deviceSecret: string; // 明文，仅本次返回，落库只存 sha256
    pairCode: string;
    reclaimed: boolean;
    serverTime: string;
  }> {
    const now = new Date();

    // 预检：节流命中时直接拒绝，避免白白消耗熵 + 一次 pair_code 唯一性查询。
    // 事务内持 device 行锁后还会复检一次，保证并发 reset 不会绕过节流。
    const preExisting = await this.prisma.device.findUnique({
      where: { mac },
      select: { lastRegisteredAt: true },
    });
    if (preExisting?.lastRegisteredAt) {
      const elapsedMs = now.getTime() - preExisting.lastRegisteredAt.getTime();
      if (elapsedMs < REGISTER_RESET_THROTTLE_MS) {
        throw throttleError(elapsedMs);
      }
    }

    const outcome = await this.prisma
      .$transaction(
        async (tx): Promise<RegisterResetOutcome & { secret: string; pairCode: string }> => {
          await lockDeviceMacRow(tx, mac);
          const current = await tx.device.findUnique({
            where: { mac },
            select: { id: true, ownerUserId: true, lastRegisteredAt: true, secretHash: true },
          });
          if (!current) {
            const secret = generateSecret();
            const secretHash = hashDeviceSecret(secret);
            const pairCode = await this.generateUniquePairCode(tx);
            const created = await tx.device.create({
              data: { mac, secretHash, pairCode, lastRegisteredAt: now },
              select: { id: true },
            });
            return {
              deviceId: created.id,
              reclaimed: false,
              previousOwnerUserId: null,
              previousSecretHash: null,
              isFirstRegister: true,
              secret,
              pairCode,
            };
          }

          const elapsedMs = current.lastRegisteredAt
            ? now.getTime() - current.lastRegisteredAt.getTime()
            : Number.POSITIVE_INFINITY;
          if (elapsedMs < REGISTER_RESET_THROTTLE_MS) {
            throw throttleError(elapsedMs);
          }
          const secret = generateSecret();
          const secretHash = hashDeviceSecret(secret);
          const pairCode = await this.generateUniquePairCode(tx);
          await tx.device.update({
            where: { mac },
            data: {
              secretHash,
              pairCode,
              ownerUserId: null,
              selectedGroupId: null,
              lastRegisteredAt: now,
            },
          });
          return {
            deviceId: current.id,
            reclaimed: current.ownerUserId !== null,
            previousOwnerUserId: current.ownerUserId,
            previousSecretHash: current.secretHash,
            isFirstRegister: false,
            secret,
            pairCode,
          };
        }
      )
      .catch((err: unknown) => {
        // 并发场景：两个同 mac 的 register 都看到 current=null，第一个 create 后第二个撞 mac
        // 唯一约束 P2002。让客户端短延迟重试，避免在 reset 路径上暴露 5xx。
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          prismaUniqueTargetIncludes(err, 'mac')
        ) {
          throw new ConflictError('设备并发注册中，请重试', {
            code: 'register_race',
            retry_after_sec: 1,
          });
        }
        throw err;
      });

    if (outcome.isFirstRegister) {
      this.logger.log(`device first registered: mac=${mac} id=${outcome.deviceId}`);
    } else if (outcome.reclaimed) {
      this.logger.log(
        `device reclaimed (physical reset): mac=${mac} id=${outcome.deviceId} prev_owner=${maskId(outcome.previousOwnerUserId)}`
      );
    } else {
      this.logger.log(`device re-registered (was unowned): mac=${mac} id=${outcome.deviceId}`);
    }
    invalidateDeviceSecretHash(outcome.previousSecretHash);

    return {
      deviceId: outcome.deviceId,
      deviceSecret: outcome.secret,
      pairCode: outcome.pairCode,
      reclaimed: outcome.reclaimed,
      serverTime: now.toISOString(),
    };
  }

  async recordTelemetry(
    deviceId: string,
    t: TelemetryInput | undefined
  ): Promise<DevicePollSnapshot> {
    try {
      return await this.prisma.device.update({
        where: { id: deviceId },
        data: {
          lastSeenAt: new Date(),
          ...(t?.battery_pct !== undefined ? { batteryPct: t.battery_pct } : {}),
          ...(t?.rssi_dbm !== undefined ? { rssiDbm: t.rssi_dbm } : {}),
          ...(t?.fw_version !== undefined ? { fwVersion: t.fw_version } : {}),
        },
        select: {
          id: true,
          mac: true,
          name: true,
          ownerUserId: true,
          selectedGroupId: true,
          pairCode: true,
          selectedGroup: { select: { manifestEtag: true } },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError('设备不存在');
      }
      throw err;
    }
  }

  // ── poll/cycle 共用：build 当前 DeviceState ────────────────

  async buildState(
    deviceId: string,
    cached?: { group?: CycleResult; device?: DevicePollSnapshot }
  ): Promise<DeviceStateT> {
    const [device, resolvedGroup] = await Promise.all([
      cached?.device !== undefined
        ? Promise.resolve(cached.device)
        : this.prisma.device.findUnique({
            where: { id: deviceId },
            select: {
              id: true,
              mac: true,
              name: true,
              ownerUserId: true,
              selectedGroupId: true,
              pairCode: true,
              selectedGroup: { select: { manifestEtag: true } },
            },
          }),
      cached?.group !== undefined
        ? Promise.resolve(cached.group)
        : cached?.device !== undefined
          ? this.groups.describeDeviceGroupSnapshot(cached.device)
          : this.groups.describeDeviceGroup(deviceId),
    ]);
    if (!device) {
      throw new NotFoundError(`device ${deviceId} disappeared mid-request`);
    }

    const bound = device.ownerUserId !== null;
    const group = normalizeCycleResult(resolvedGroup);
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
      group: group
        ? {
            id: group.groupId,
            structure_etag: group.structureEtag,
            manifest_etag: group.manifestEtag,
            name: group.name,
            content_count: group.contentCount,
            sort_order: group.sortOrder,
            position: group.position,
          }
        : null,
    };
  }

  // ── admin 端业务 ────────────────────────────────────────────

  async listForOwner(ownerUserId: string): Promise<DeviceSummaryT[]> {
    const rows = await this.prisma.device.findMany({
      where: { ownerUserId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: DEVICE_SUMMARY_SELECT,
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
    await this.prisma.device.update({ where: { id: deviceId }, data });
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
        const sortOrder = await this.nextDeviceSortOrder(ownerUserId, tx);
        const newPairCode = await this.generateUniquePairCode(tx);
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
        `device claimed by pair code: id=${device.id} owner=${maskId(ownerUserId)}` +
          (device.selectedGroupId
            ? ` auto-bound to group ${device.selectedGroupId}`
            : ' (owner has no group yet)')
      );
    } else {
      this.logger.log(`device re-claim no-op (already owned by self): id=${device.id}`);
    }
    return toSummary(device);
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
      const newPairCode = await this.generateUniquePairCode(tx);
      await tx.device.update({
        where: { id: deviceId },
        data: {
          ownerUserId: null,
          selectedGroupId: null,
          pairCode: newPairCode,
        },
      });
    });
    this.logger.log(`device unbound: id=${deviceId} new_pair_code=***`);
  }

  async reorderDevices(ownerUserId: string, order: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUserRow(tx, ownerUserId);
      const owned = await tx.device.findMany({
        where: { ownerUserId },
        select: { id: true },
      });
      const ownedSet = new Set(owned.map((d) => d.id));
      const orderSet = new Set(order);
      if (orderSet.size !== order.length) {
        throw new ValidationError('排序列表不能包含重复设备', { code: 'order_duplicate' });
      }
      const unknownIds = order.filter((id) => !ownedSet.has(id));
      if (unknownIds.length > 0) {
        throw new ValidationError('排序列表包含不属于当前用户的设备', {
          code: 'order_unknown_device',
        });
      }
      if (order.length !== ownedSet.size) {
        throw new ValidationError('排序列表须包含所有设备', {
          code: 'order_missing_device',
        });
      }
      await bulkSetDeviceSortOrder(tx, ownerUserId, order);
    });
  }

  // ── 内部 helpers ────────────────────────────────────────────

  private async nextDeviceSortOrder(
    ownerUserId: string,
    client: PrismaClientLike = this.prisma
  ): Promise<number> {
    const last = await client.device.findFirst({
      where: { ownerUserId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
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

  // 6 位字母表：A-Z 去 I/L/O + 2-9。PAIR_CODE_ALPHABET.length^6 ≈ 8.8 亿，撞概率极低，
  // 但仍按 unique 约束最多重试 8 次以兜底。
  private async generateUniquePairCode(client: PrismaClientLike = this.prisma): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generatePairCode();
      const exists = await client.device.findUnique({
        where: { pairCode: code },
        select: { id: true },
      });
      if (!exists) return code;
    }
    throw new ConflictError('配对码生成冲突，请重试', { code: 'pair_code_generation_failed' });
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

function generatePairCode(): string {
  let code = '';
  while (code.length < 6) {
    for (const byte of randomBytes(8)) {
      if (byte >= PAIR_CODE_RANDOM_LIMIT) continue;
      code += PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

function throttleError(elapsedMs: number): ConflictError {
  const retryAfterSec = Math.max(Math.ceil((REGISTER_RESET_THROTTLE_MS - elapsedMs) / 1000), 1);
  return new ConflictError('设备刚刚注册过，请稍后再重置', {
    code: 'register_throttled',
    retry_after_sec: retryAfterSec,
  });
}

async function lockDeviceMacRow(tx: Prisma.TransactionClient, mac: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM \`devices\` WHERE mac = ${mac} FOR UPDATE
  `;
}

// 日志里保留 id 末四位，便于排查；不泄露完整 id。
function maskId(id: string | null): string {
  if (!id) return 'null';
  return `***${id.slice(-4)}`;
}

function normalizeCycleResult(result: CycleResult): {
  groupId: string;
  name: string;
  structureEtag: string;
  manifestEtag: string;
  sortOrder: number;
  contentCount: number;
  position: { current: number; total: number };
} | null {
  if (!result.groupId) return null;
  if (
    result.name === null ||
    result.structureEtag === null ||
    result.manifestEtag === null ||
    result.sortOrder === null ||
    result.position === null
  ) {
    throw new Error(`invalid cycle result for group ${result.groupId}`);
  }
  return {
    groupId: result.groupId,
    name: result.name,
    structureEtag: result.structureEtag,
    manifestEtag: result.manifestEtag,
    sortOrder: result.sortOrder,
    contentCount: result.contentCount,
    position: result.position,
  };
}
