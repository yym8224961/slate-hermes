// 跨路由复用的格式化与状态判定。
// 原本散在 Dashboard / DeviceDetail 里,现在收口。

import type { DeviceSummaryT } from 'shared';

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export function isOnline(d: { last_seen_at: string | null }): boolean {
  if (!d.last_seen_at) return false;
  return Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_THRESHOLD_MS;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '从未上线';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function rssiLabel(rssi: number | null): string {
  if (rssi == null) return '—';
  if (rssi >= -65) return '良好';
  if (rssi >= -75) return '一般';
  if (rssi >= -85) return '弱';
  return '极弱';
}

// MAC 规范化:展示用大写 + 冒号分隔。
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

// MAC 格式校验(规范化前的宽松版,允许空格 / 短横 / 冒号 / 大小写)。
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/;
export function isValidMac(input: string): boolean {
  return MAC_REGEX.test(input.trim().replace(/\s/g, ''));
}

// 短 mac 尾号(用于卡片或 modal 头部副标)。
export function macTail(mac: string, n = 5): string {
  return mac.replace(/:/g, '').slice(-n);
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

// 字节数 → 人读字符串。组卡 / 详情显示组的总素材体积。
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
