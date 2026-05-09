import { ReorderDevicesRequest, type ReorderDevicesRequestT } from 'shared';

export class ReorderDevicesDto implements ReorderDevicesRequestT {
  static readonly schema = ReorderDevicesRequest;
  declare order: string[];
}
