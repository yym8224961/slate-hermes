import { describe, expect, it } from 'bun:test';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { GroupsService } from '../groups/groups.service';
import { DevicesService } from './devices.service';

interface DeviceRecord {
  id: string;
  mac: string;
  secretHash: string;
  pairCode: string;
  ownerUserId: string | null;
  selectedGroupId: string | null;
  lastRegisteredAt: Date | null;
}

interface FindUniqueArgs {
  where: {
    mac?: string;
    pairCode?: string;
  };
}

interface UpdateArgs {
  where: {
    mac: string;
  };
  data: Partial<DeviceRecord>;
}

interface CreateArgs {
  data: Pick<DeviceRecord, 'mac' | 'secretHash' | 'pairCode' | 'lastRegisteredAt'>;
  select: {
    id: true;
  };
}

function createService(record?: DeviceRecord): {
  service: DevicesService;
  updates: UpdateArgs[];
  creates: CreateArgs[];
  getRecord: () => DeviceRecord | undefined;
} {
  let current = record;
  const updates: UpdateArgs[] = [];
  const creates: CreateArgs[] = [];
  const deviceApi = {
    findUnique: async (args: FindUniqueArgs) => {
      if (args.where.mac !== undefined) {
        if (!current || current.mac !== args.where.mac) return null;
        return {
          id: current.id,
          ownerUserId: current.ownerUserId,
          lastRegisteredAt: current.lastRegisteredAt,
        };
      }
      if (args.where.pairCode !== undefined) return null;
      return null;
    },
    update: async (args: UpdateArgs) => {
      updates.push(args);
      if (!current || current.mac !== args.where.mac) throw new Error('missing device');
      current = { ...current, ...args.data };
      return current;
    },
    create: async (args: CreateArgs) => {
      creates.push(args);
      current = {
        id: 'new-device',
        mac: args.data.mac,
        secretHash: args.data.secretHash,
        pairCode: args.data.pairCode,
        ownerUserId: null,
        selectedGroupId: null,
        lastRegisteredAt: args.data.lastRegisteredAt,
      };
      return { id: current.id };
    },
  };
  const txApi = {
    device: deviceApi,
    $queryRaw: async () => [{ id: current?.ownerUserId ?? 'user-1' }],
  };
  const prisma = {
    device: deviceApi,
    $transaction: async <T>(fn: (tx: typeof txApi) => Promise<T>) => fn(txApi),
  };
  return {
    service: new DevicesService(prisma as unknown as PrismaService, {} as GroupsService),
    updates,
    creates,
    getRecord: () => current,
  };
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'device-1',
    mac: 'AA:BB:CC:DD:EE:FF',
    secretHash: 'old-secret',
    pairCode: 'ABC234',
    ownerUserId: 'user-1',
    selectedGroupId: 'group-1',
    lastRegisteredAt: null,
    ...overrides,
  };
}

describe('DevicesService.registerOrReset', () => {
  it('creates a new device with lastRegisteredAt', async () => {
    const { service, creates, getRecord } = createService();

    const result = await service.registerOrReset('AA:BB:CC:DD:EE:FF');

    expect(result.deviceId).toBe('new-device');
    expect(result.reclaimed).toBe(false);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.data.lastRegisteredAt).toBeInstanceOf(Date);
    expect(getRecord()?.lastRegisteredAt).toBeInstanceOf(Date);
  });

  it('rejects a bound device reset inside the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({ lastRegisteredAt: new Date(Date.now() - 1_000) })
    );

    await expect(service.registerOrReset('AA:BB:CC:DD:EE:FF')).rejects.toThrow(ConflictError);

    expect(updates).toHaveLength(0);
    expect(getRecord()?.ownerUserId).toBe('user-1');
    expect(getRecord()?.selectedGroupId).toBe('group-1');
  });

  it('allows an unowned device reset inside the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({
        ownerUserId: null,
        selectedGroupId: null,
        lastRegisteredAt: new Date(Date.now() - 1_000),
      })
    );

    const result = await service.registerOrReset('AA:BB:CC:DD:EE:FF');

    expect(result.reclaimed).toBe(false);
    expect(updates).toHaveLength(1);
    expect(getRecord()?.ownerUserId).toBeNull();
  });

  it('allows a bound device reset after the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({ lastRegisteredAt: new Date(Date.now() - 61_000) })
    );

    const result = await service.registerOrReset('AA:BB:CC:DD:EE:FF');

    expect(result.reclaimed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(getRecord()?.ownerUserId).toBeNull();
    expect(getRecord()?.selectedGroupId).toBeNull();
  });
});

function createClaimService(
  record?: DeviceRecord,
  opts: {
    raceOnUpdate?: 'P2025' | 'P2002';
    raceTarget?: string[];
    ownerGroups?: { id: string }[];
  } = {}
): {
  service: DevicesService;
  updates: { where: unknown; data: Partial<DeviceRecord> }[];
  getRecord: () => DeviceRecord | undefined;
} {
  let current = record;
  const updates: { where: unknown; data: Partial<DeviceRecord> }[] = [];
  const deviceApi = {
    findUnique: async (args: { where: { pairCode?: string } }) => {
      if (!current || args.where.pairCode !== current.pairCode) return null;
      return current;
    },
    findFirst: async () => ({ sortOrder: 1 }),
    update: async (args: {
      where: { id?: string; ownerUserId?: string | null };
      data: Partial<DeviceRecord> & { sortOrder?: number };
    }) => {
      updates.push(args);
      if (opts.raceOnUpdate) {
        throw new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: opts.raceOnUpdate,
          clientVersion: 'test',
          meta: opts.raceTarget ? { target: opts.raceTarget } : undefined,
        });
      }
      if (
        !current ||
        args.where.id !== current.id ||
        (args.where.ownerUserId !== undefined && args.where.ownerUserId !== current.ownerUserId)
      ) {
        throw new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      current = { ...current, ...args.data };
      return current;
    },
  };
  const txApi = {
    device: deviceApi,
    $queryRaw: async () => [{ id: 'user-2' }],
  };
  const prisma = {
    device: deviceApi,
    $transaction: async <T>(fn: (tx: typeof txApi) => Promise<T>) => fn(txApi),
  };
  const groups = {
    listOwnerGroups: async () =>
      opts.ownerGroups ?? [
        {
          id: 'group-1',
          name: 'Group 1',
          structureEtag: 'structure-1',
          manifestEtag: 'manifest-1',
          sortOrder: 0,
          _count: { contents: 0 },
        },
      ],
  };
  return {
    service: new DevicesService(
      prisma as unknown as PrismaService,
      groups as unknown as GroupsService
    ),
    updates,
    getRecord: () => current,
  };
}

describe('DevicesService.claimByPairCode', () => {
  it('claims an unowned device and assigns the first owner group', async () => {
    const { service, getRecord } = createClaimService(
      device({ ownerUserId: null, selectedGroupId: null })
    );

    const result = await service.claimByPairCode('ABC234', 'user-2');

    expect(result.id).toBe('device-1');
    expect(result.owner_user_id).toBe('user-2');
    expect(result.selected_group_id).toBe('group-1');
    expect(result.sort_order).toBe(2);
    expect(getRecord()?.pairCode).not.toBe('ABC234');
  });

  it('leaves an empty selected_group_id when owner has no group yet', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      ownerGroups: [],
    });

    const result = await service.claimByPairCode('ABC234', 'user-2');

    expect(result.selected_group_id).toBeNull();
  });

  it('returns a clear not-found error for an invalid pair code', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }));

    await expect(service.claimByPairCode('NOPE99', 'user-2')).rejects.toThrow(NotFoundError);
  });

  it('rejects with forbidden when device is already owned by another user', async () => {
    const { service, updates } = createClaimService(
      device({ ownerUserId: 'user-1', selectedGroupId: 'group-1' })
    );

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ForbiddenError);
    // 不应尝试任何 update。
    expect(updates).toHaveLength(0);
  });

  it('is a no-op when the same owner re-claims their own device', async () => {
    const { service, updates, getRecord } = createClaimService(
      device({ ownerUserId: 'user-1', selectedGroupId: 'group-1' })
    );

    const result = await service.claimByPairCode('ABC234', 'user-1');

    expect(result.owner_user_id).toBe('user-1');
    // 同 owner re-claim：不应轮换 pairCode、不应改 sortOrder。
    expect(updates).toHaveLength(0);
    expect(getRecord()?.pairCode).toBe('ABC234');
  });

  it('maps concurrent CAS misses (P2025) to conflict instead of a generic prisma error', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      raceOnUpdate: 'P2025',
    });

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ConflictError);
  });

  it('maps pair_code unique-constraint collisions (P2002) to conflict as well', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      raceOnUpdate: 'P2002',
      raceTarget: ['pair_code'],
    });

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ConflictError);
  });
});
