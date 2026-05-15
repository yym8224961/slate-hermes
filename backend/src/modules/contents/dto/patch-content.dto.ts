import { PatchContentRequest, type PatchContentRequestT } from 'shared';

export class PatchContentDto implements PatchContentRequestT {
  static readonly schema = PatchContentRequest;
  declare title?: string | null;
}
