import { ClaimByPairCodeRequest, type ClaimByPairCodeRequestT } from 'shared';

export class ClaimByPairCodeDto implements ClaimByPairCodeRequestT {
  static readonly schema = ClaimByPairCodeRequest;
  declare code: string;
}
