import { createHash } from 'node:crypto';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export interface DeviceSecretAuthContext {
  deviceId: string;
  mac: string;
}

interface CacheEntry {
  device: DeviceSecretAuthContext;
  expiresAt: number;
}

const DEVICE_SECRET_CACHE_TTL_MS = 30_000;
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
  if (!device) return null;

  if (cache.size >= DEVICE_SECRET_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const context = { deviceId: device.id, mac: device.mac };
  cache.set(hash, { device: context, expiresAt: now + DEVICE_SECRET_CACHE_TTL_MS });
  return context;
}

export function invalidateDeviceSecretHash(secretHash: string | null | undefined): void {
  if (secretHash) cache.delete(secretHash);
}

export function clearDeviceSecretAuthCache(): void {
  cache.clear();
}
