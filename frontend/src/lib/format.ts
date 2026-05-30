export function formatBytes(n: number): string {
  const bytes = Number.isFinite(n) && n > 0 ? n : 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function rssiLabel(rssi: number | null): string {
  if (rssi == null) return '—';
  if (rssi >= -65) return '良好';
  if (rssi >= -75) return '一般';
  if (rssi >= -85) return '弱';
  return '极弱';
}

export function timeAgo(iso: string | null): string {
  return relativeTimeFrom(Date.now(), iso);
}

export function relativeTimeFrom(now: number, iso: string | null): string {
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
