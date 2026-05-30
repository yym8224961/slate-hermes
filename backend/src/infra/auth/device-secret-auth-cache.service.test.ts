import { beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaService } from '../prisma/prisma.service';
import { DeviceSecretAuthCacheService, hashDeviceSecret } from './device-secret-auth-cache.service';

describe('device secret auth cache', () => {
  let service: DeviceSecretAuthCacheService;

  beforeEach(() => {
    service = undefined as unknown as DeviceSecretAuthCacheService;
  });

  it('caches successful lookups by secret hash until invalidated', async () => {
    const secret = 'a'.repeat(64);
    const secretHash = hashDeviceSecret(secret);
    let calls = 0;
    const prisma = {
      device: {
        findUnique: async ({ where }: { where: { secretHash: string } }) => {
          calls += 1;
          expect(where.secretHash).toBe(secretHash);
          return { id: 'device-1', mac: 'AA:BB:CC:DD:EE:FF' };
        },
      },
    } as unknown as PrismaService;
    service = new DeviceSecretAuthCacheService(prisma);

    expect(await service.authenticate(secret, 1_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });
    expect(await service.authenticate(secret, 2_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });
    service.invalidateHash(secretHash);
    expect(await service.authenticate(secret, 3_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    expect(calls).toBe(2);
  });

  it('caches misses briefly to avoid repeated DB lookups for random secrets', async () => {
    const secret = 'b'.repeat(64);
    let calls = 0;
    const prisma = {
      device: {
        findUnique: async () => {
          calls += 1;
          return null;
        },
      },
    } as unknown as PrismaService;
    service = new DeviceSecretAuthCacheService(prisma);

    expect(await service.authenticate(secret, 1_000)).toBeNull();
    expect(await service.authenticate(secret, 2_000)).toBeNull();
    expect(await service.authenticate(secret, 7_000)).toBeNull();

    expect(calls).toBe(2);
  });
});
