export function setBoundedCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    if (!evictOldestMapEntry(cache)) break;
  }
}

export function evictOldestMapEntry<K, V>(cache: Map<K, V>): boolean {
  const oldest = cache.keys().next().value as K | undefined;
  if (oldest === undefined) return false;
  return cache.delete(oldest);
}
