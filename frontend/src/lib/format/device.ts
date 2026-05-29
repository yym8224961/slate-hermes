import type { DeviceSummaryT } from 'shared';

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
export const DEVICE_ONLINE_TICK_MS = 10_000;

export function isOnline(d: { last_seen_at: string | null }): boolean {
  return isOnlineAt(d, Date.now());
}

export function isOnlineAt(d: { last_seen_at: string | null }, now: number): boolean {
  if (!d.last_seen_at) return false;
  const lastSeen = new Date(d.last_seen_at).getTime();
  if (!Number.isFinite(lastSeen)) return false;
  return now - lastSeen < ONLINE_THRESHOLD_MS;
}

export function rssiLabel(rssi: number | null): string {
  if (rssi == null) return '—';
  if (rssi >= -65) return '良好';
  if (rssi >= -75) return '一般';
  if (rssi >= -85) return '弱';
  return '极弱';
}

// MAC 规范化：展示用大写 + 冒号分隔。
export function normalizeMac(input: string): string {
  return (
    input
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '')
      .match(/.{1,2}/g)
      ?.join(':') ?? ''
  );
}

export function isValidMac(input: string): boolean {
  const compact = input.trim().replace(/\s/g, '');
  if (/^[0-9A-Fa-f]{12}$/.test(compact)) return true;
  return /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(compact);
}

// 配对码规范化：去空格、横线，统一大写。
export function normalizePairCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const PAIR_CODE_REGEX = /^[A-Z0-9]{6}$/;
export function isValidPairCode(input: string): boolean {
  return PAIR_CODE_REGEX.test(normalizePairCode(input));
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
