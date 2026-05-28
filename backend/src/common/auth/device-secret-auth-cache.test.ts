import { beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import {
  authenticateDeviceSecret,
  clearDeviceSecretAuthCache,
  hashDeviceSecret,
  invalidateDeviceSecretHash,
} from './device-secret-auth-cache';

describe('device secret auth cache', () => {
  beforeEach(() => {
    clearDeviceSecretAuthCache();
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

    expect(await authenticateDeviceSecret(prisma, secret, 1_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });
    expect(await authenticateDeviceSecret(prisma, secret, 2_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });
    invalidateDeviceSecretHash(secretHash);
    expect(await authenticateDeviceSecret(prisma, secret, 3_000)).toEqual({
      deviceId: 'device-1',
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    expect(calls).toBe(2);
  });
});
