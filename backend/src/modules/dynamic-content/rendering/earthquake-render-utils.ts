import { pickText } from './frame-value-utils';
import { shortEarthquakeTime } from './frame-date-utils';

export function earthquakeFields(item: Record<string, unknown>): {
  time: string;
  depth: string;
  coords: string;
} {
  const occurredAt = shortEarthquakeTime(pickText(item.occurredAt, ''));
  const depth = pickText(item.depthKm, '');
  const longitude = pickText(item.longitude, '');
  const latitude = pickText(item.latitude, '');
  const depthText = depth && depth !== '-' && depth !== '--' ? `${depth}千米` : '--';
  const coords = [longitude ? `经${longitude}` : '', latitude ? `纬${latitude}` : '']
    .filter(Boolean)
    .join('  ');
  return { time: occurredAt, depth: depthText, coords };
}
