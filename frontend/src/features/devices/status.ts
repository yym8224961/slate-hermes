import { useEffect, useState } from 'react';
import type { DeviceSummaryT } from 'shared';

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const ONLINE_TIMEOUT_MARGIN_MS = 50;

export function isOnline(d: { last_seen_at: string | null }): boolean {
  return isOnlineAt(d, Date.now());
}

export function isOnlineAt(d: { last_seen_at: string | null }, now: number): boolean {
  return onlineSnapshot(d.last_seen_at, now).online;
}

export function useDeviceOnline(lastSeenAt: string | null): boolean {
  const [online, setOnline] = useState(() => isOnlineAt({ last_seen_at: lastSeenAt }, Date.now()));

  useEffect(() => {
    const now = Date.now();
    const snapshot = onlineSnapshot(lastSeenAt, now);
    setOnline(snapshot.online);
    if (!snapshot.online || snapshot.offlineAt === null) return;

    const timeout = window.setTimeout(
      () => setOnline(false),
      Math.max(0, snapshot.offlineAt - Date.now() + ONLINE_TIMEOUT_MARGIN_MS)
    );
    return () => window.clearTimeout(timeout);
  }, [lastSeenAt]);

  return online;
}

export function deviceStatus(d: DeviceSummaryT): {
  online: boolean;
  lowBattery: boolean;
} {
  return {
    online: isOnline(d),
    lowBattery: d.battery_pct != null && d.battery_pct < 20,
  };
}

function lastSeenTime(iso: string | null): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? time : null;
}

function onlineSnapshot(
  lastSeenAt: string | null,
  now: number
): { online: boolean; offlineAt: number | null } {
  const lastSeen = lastSeenTime(lastSeenAt);
  if (lastSeen === null) return { online: false, offlineAt: null };
  return {
    online: now - lastSeen < ONLINE_THRESHOLD_MS,
    offlineAt: lastSeen + ONLINE_THRESHOLD_MS,
  };
}
