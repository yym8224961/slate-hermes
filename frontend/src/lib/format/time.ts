import { useCallback, useSyncExternalStore } from 'react';

const DEFAULT_TIME_AGO_INTERVAL_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 1_000;
const TICK_BUCKET_MS = 5_000;
interface TimeAgoStore {
  now: number;
  timer: number | null;
  listeners: Set<() => void>;
}

const stores = new Map<number, TimeAgoStore>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stores.forEach((store) => {
      if (store.timer !== null) window.clearInterval(store.timer);
      store.listeners.clear();
      store.timer = null;
    });
    stores.clear();
  });
}

export function timeAgo(iso: string | null): string {
  return relativeTimeFrom(Date.now(), iso);
}

export function useTimeAgo(iso: string | null, intervalMs = DEFAULT_TIME_AGO_INTERVAL_MS): string {
  const now = useNow(intervalMs);
  return relativeTimeFrom(now, iso);
}

export function useNow(intervalMs = DEFAULT_TIME_AGO_INTERVAL_MS): number {
  const normalizedInterval = normalizeInterval(intervalMs);
  const subscribe = useCallback(
    (listener: () => void) => subscribeTicker(listener, normalizedInterval),
    [normalizedInterval]
  );
  const getSnapshot = useCallback(() => getNowSnapshot(normalizedInterval), [normalizedInterval]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribeTicker(listener: () => void, intervalMs: number) {
  const safeIntervalMs = normalizeInterval(intervalMs);
  const store = getStore(safeIntervalMs);
  store.listeners.add(listener);
  tick(store);
  if (store.timer === null) {
    store.timer = window.setInterval(() => tick(store), safeIntervalMs);
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      if (store.timer !== null) {
        window.clearInterval(store.timer);
        store.timer = null;
      }
      stores.delete(safeIntervalMs);
    }
  };
}

function getNowSnapshot(intervalMs: number) {
  return getStore(normalizeInterval(intervalMs)).now;
}

function normalizeInterval(intervalMs: number) {
  if (!Number.isFinite(intervalMs)) return DEFAULT_TIME_AGO_INTERVAL_MS;
  const safeIntervalMs = Math.max(MIN_TICK_INTERVAL_MS, Math.trunc(intervalMs));
  return Math.round(safeIntervalMs / TICK_BUCKET_MS) * TICK_BUCKET_MS || MIN_TICK_INTERVAL_MS;
}

function getStore(safeIntervalMs: number): TimeAgoStore {
  let store = stores.get(safeIntervalMs);
  if (!store) {
    store = { now: Date.now(), timer: null, listeners: new Set() };
    stores.set(safeIntervalMs, store);
  }
  return store;
}

function tick(store: TimeAgoStore) {
  store.now = Date.now();
  store.listeners.forEach((listener) => listener());
}

function relativeTimeFrom(now: number, iso: string | null): string {
  if (!iso) return '从未上线';
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '从未上线';
  const ms = Math.max(0, now - timestamp);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
