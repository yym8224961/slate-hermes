import { ClaimDeviceRequest, type ClaimDeviceRequestT } from 'shared';

export class ClaimDeviceDto implements ClaimDeviceRequestT {
  static readonly schema = ClaimDeviceRequest;
  declare pair_code: string;
}
