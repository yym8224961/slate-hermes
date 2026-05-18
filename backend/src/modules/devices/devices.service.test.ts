import { describe, expect, it } from 'bun:test';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { ConflictError } from '../../common/errors';
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
  const prisma = {
    device: {
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
    },
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
