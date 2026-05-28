import { useCallback, useSyncExternalStore } from 'react';

const DEFAULT_TIME_AGO_INTERVAL_MS = 30_000;
interface TimeAgoStore {
  now: number;
  timer: number | null;
  listeners: Set<() => void>;
}

const stores = new Map<number, TimeAgoStore>();

export function timeAgo(iso: string | null): string {
  return relativeTimeFrom(Date.now(), iso);
}

export function useTimeAgo(iso: string | null, intervalMs = 30_000): string {
  const normalizedInterval = normalizeInterval(intervalMs);
  const subscribe = useCallback(
    (listener: () => void) => subscribeTicker(listener, normalizedInterval),
    [normalizedInterval]
  );
  const getSnapshot = useCallback(() => getNowSnapshot(normalizedInterval), [normalizedInterval]);
  const now = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return relativeTimeFrom(now, iso);
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
    if (store.listeners.size === 0 && store.timer !== null) {
      window.clearInterval(store.timer);
      store.timer = null;
    }
  };
}

function getNowSnapshot(intervalMs: number) {
  return getStore(normalizeInterval(intervalMs)).now;
}

function normalizeInterval(intervalMs: number) {
  const safeIntervalMs = Math.max(1, Math.trunc(intervalMs));
  return Number.isFinite(safeIntervalMs) ? safeIntervalMs : DEFAULT_TIME_AGO_INTERVAL_MS;
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

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 22) return '晚上好';
  return '夜深了';
}
