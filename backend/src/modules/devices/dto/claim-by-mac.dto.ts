import { ClaimByMacRequest, type ClaimByMacRequestT } from 'shared';

export class ClaimByMacDto implements ClaimByMacRequestT {
  static readonly schema = ClaimByMacRequest;
  declare mac: string;
  declare name?: string;
}
