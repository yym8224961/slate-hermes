import { PatchFrameRequest, type PatchFrameRequestT } from 'shared';

export class PatchFrameDto implements PatchFrameRequestT {
  static readonly schema = PatchFrameRequest;
  declare caption?: string | null;
}
