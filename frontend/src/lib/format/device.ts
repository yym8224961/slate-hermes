export function rssiLabel(rssi: number | null): string {
  if (rssi == null) return '—';
  if (rssi >= -65) return '良好';
  if (rssi >= -75) return '一般';
  if (rssi >= -85) return '弱';
  return '极弱';
}
