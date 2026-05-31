import { InternalError } from '../../common/errors';
import type { CycleResult } from '../groups/groups.service';
import type { DevicePollSnapshot } from './device-types';

export function toDeviceStatePayload(device: DevicePollSnapshot, resolvedGroup: CycleResult) {
  const bound = device.ownerUserId !== null;
  const group = normalizeCycleResult(resolvedGroup);
  return {
    device: {
      id: device.id,
      mac: device.mac,
      name: device.name,
      bound,
      // 已绑定不返回 pair_code，避免冗余暴露（已绑定的码也无法被再次 claim，但守住「最小披露」）。
      pair_code: bound ? null : device.pairCode,
      server_time: new Date().toISOString(),
    },
    group: group
      ? {
          id: group.groupId,
          structure_etag: group.structureEtag,
          manifest_etag: group.manifestEtag,
          name: group.name,
          content_count: group.contentCount,
          sort_order: group.sortOrder,
          position: group.position,
        }
      : null,
  };
}

function normalizeCycleResult(result: CycleResult): {
  groupId: string;
  name: string;
  structureEtag: string;
  manifestEtag: string;
  sortOrder: number;
  contentCount: number;
  position: { current: number; total: number };
} | null {
  if (!result.groupId) return null;
  if (
    result.name === null ||
    result.structureEtag === null ||
    result.manifestEtag === null ||
    result.sortOrder === null ||
    result.position === null
  ) {
    throw new InternalError(`invalid cycle result for group ${result.groupId}`);
  }
  return {
    groupId: result.groupId,
    name: result.name,
    structureEtag: result.structureEtag,
    manifestEtag: result.manifestEtag,
    sortOrder: result.sortOrder,
    contentCount: result.contentCount,
    position: result.position,
  };
}
