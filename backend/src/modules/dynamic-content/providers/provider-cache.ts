import { setBoundedCache } from '../../../common/utils/cache-utils';

export const DEFAULT_PROVIDER_CACHE_TTL_SEC = 600;
export const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 5000;

export interface TimedCacheEntry<V> {
  data: V;
  fetchedAt: number;
}

export class CachedInflightFetcher<K, V> {
  private readonly cache = new Map<K, TimedCacheEntry<V>>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(private readonly maxEntries: number) {}

  getFresh(key: K, now: number, ttlMs: number): V | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (now - cached.fetchedAt < ttlMs) return cached.data;
    this.cache.delete(key);
    return null;
  }

  getOrFetch(key: K, now: number, ttlMs: number, fetcher: () => Promise<V>): Promise<V> {
    const cached = this.getFresh(key, now, ttlMs);
    if (cached) return Promise.resolve(cached);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = fetcher()
      .then((data) => {
        setBoundedCache(this.cache, key, { data, fetchedAt: now }, this.maxEntries);
        return data;
      })
      .finally(() => {
        if (this.inflight.get(key) === task) this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  set(key: K, data: V, fetchedAt: number): void {
    setBoundedCache(this.cache, key, { data, fetchedAt }, this.maxEntries);
  }
}

export function isRecentTimestamp(value: unknown, now: Date, maxAgeMs: number): boolean {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= maxAgeMs;
}
