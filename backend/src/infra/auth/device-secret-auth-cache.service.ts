import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { setBoundedCache } from '../../common/utils/cache-utils';
import type { DeviceContext } from '../../common/decorators/current-device.decorator';

interface CacheEntry {
  device: DeviceContext | null;
  expiresAt: number;
}

const DEVICE_SECRET_CACHE_TTL_MS = 30_000;
const DEVICE_SECRET_NEGATIVE_CACHE_TTL_MS = 5_000;
const DEVICE_SECRET_CACHE_MAX = 10_000;

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

@Injectable()
export class DeviceSecretAuthCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async authenticate(secret: string, now: number = Date.now()): Promise<DeviceContext | null> {
    const hash = hashDeviceSecret(secret);
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) {
      setBoundedCache(this.cache, hash, cached, DEVICE_SECRET_CACHE_MAX);
      return cached.device;
    }
    if (cached) this.cache.delete(hash);

    const device = await this.prisma.device.findUnique({
      where: { secretHash: hash },
      select: { id: true, mac: true },
    });
    if (!device) {
      this.setCache(hash, null, now + DEVICE_SECRET_NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const context = { deviceId: device.id, mac: device.mac };
    this.setCache(hash, context, now + DEVICE_SECRET_CACHE_TTL_MS);
    return context;
  }

  invalidateHash(secretHash: string | null | undefined): void {
    if (secretHash) this.cache.delete(secretHash);
  }

  private setCache(hash: string, device: DeviceContext | null, expiresAt: number): void {
    setBoundedCache(this.cache, hash, { device, expiresAt }, DEVICE_SECRET_CACHE_MAX);
  }
}
