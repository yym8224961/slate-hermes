import { createHash } from 'node:crypto';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export interface DeviceSecretAuthContext {
  deviceId: string;
  mac: string;
}

interface CacheEntry {
  device: DeviceSecretAuthContext | null;
  expiresAt: number;
}

const DEVICE_SECRET_CACHE_TTL_MS = 30_000;
const DEVICE_SECRET_NEGATIVE_CACHE_TTL_MS = 5_000;
const DEVICE_SECRET_CACHE_MAX = 10_000;
const cache = new Map<string, CacheEntry>();

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export async function authenticateDeviceSecret(
  prisma: PrismaService,
  secret: string,
  now: number = Date.now()
): Promise<DeviceSecretAuthContext | null> {
  const hash = hashDeviceSecret(secret);
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > now) {
    cache.delete(hash);
    cache.set(hash, cached);
    return cached.device;
  }
  if (cached) cache.delete(hash);

  const device = await prisma.device.findUnique({
    where: { secretHash: hash },
    select: { id: true, mac: true },
  });
  if (!device) {
    setCache(hash, null, now + DEVICE_SECRET_NEGATIVE_CACHE_TTL_MS);
    return null;
  }

  const context = { deviceId: device.id, mac: device.mac };
  setCache(hash, context, now + DEVICE_SECRET_CACHE_TTL_MS);
  return context;
}

export function invalidateDeviceSecretHash(secretHash: string | null | undefined): void {
  if (secretHash) cache.delete(secretHash);
}

export function clearDeviceSecretAuthCache(): void {
  cache.clear();
}

function setCache(hash: string, device: DeviceSecretAuthContext | null, expiresAt: number): void {
  if (cache.has(hash)) cache.delete(hash);
  while (cache.size >= DEVICE_SECRET_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(hash, { device, expiresAt });
}
