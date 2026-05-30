import type { DeviceSummaryT } from 'shared';

export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export function isOnline(d: { last_seen_at: string | null }): boolean {
  return isOnlineAt(d, Date.now());
}

export function isOnlineAt(d: { last_seen_at: string | null }, now: number): boolean {
  return onlineSnapshot(d.last_seen_at, now).online;
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

export function onlineSnapshot(
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

function lastSeenTime(iso: string | null): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? time : null;
}
