import type { DynamicConfigT } from 'shared';
import { defaultFrameName } from '@/features/contents/model/frame-name';

export function frameNameForSyncedDynamicConfigChange(
  previous: DynamicConfigT,
  next: DynamicConfigT
): string | null {
  if (
    next.type === 'weather' &&
    previous.type === 'weather' &&
    next.location_label !== previous.location_label
  ) {
    return defaultFrameName(next.type, next);
  }
  if (
    next.type === 'weather_alert' &&
    previous.type === 'weather_alert' &&
    next.province !== previous.province
  ) {
    return defaultFrameName(next.type, next);
  }
  return null;
}
