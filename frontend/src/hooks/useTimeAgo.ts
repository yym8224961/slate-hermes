import { useEffect, useState } from 'react';
import { relativeTimeFrom } from '@/lib/format';

const DEFAULT_TIME_AGO_INTERVAL_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 1_000;

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
