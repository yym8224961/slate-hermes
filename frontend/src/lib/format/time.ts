import { useEffect, useState } from 'react';

const DEFAULT_TIME_AGO_INTERVAL_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 1_000;

export function timeAgo(iso: string | null): string {
  return relativeTimeFrom(Date.now(), iso);
}

export function useTimeAgo(iso: string | null, intervalMs = DEFAULT_TIME_AGO_INTERVAL_MS): string {
  const now = useNow(intervalMs);
  return relativeTimeFrom(now, iso);
}

export function useNow(intervalMs = DEFAULT_TIME_AGO_INTERVAL_MS): number {
  const normalizedInterval = normalizeInterval(intervalMs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), normalizedInterval);
    return () => window.clearInterval(timer);
  }, [normalizedInterval]);

  return now;
}

function normalizeInterval(intervalMs: number) {
  if (!Number.isFinite(intervalMs)) return DEFAULT_TIME_AGO_INTERVAL_MS;
  return Math.max(MIN_TICK_INTERVAL_MS, Math.trunc(intervalMs));
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
