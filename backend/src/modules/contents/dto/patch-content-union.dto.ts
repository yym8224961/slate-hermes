import { z } from 'zod';
import { DynamicConfig, PatchContentRequest, type PatchDynamicContentRequestT } from 'shared';

const PatchContentUnionRequest = PatchContentRequest.extend({
  config: DynamicConfig.optional(),
});

export class PatchContentUnionDto implements PatchDynamicContentRequestT {
  static readonly schema = PatchContentUnionRequest;
  declare frame_name?: string | null;
  declare config?: PatchDynamicContentRequestT['config'];
}

export type PatchContentUnionDtoT = z.infer<typeof PatchContentUnionRequest>;
