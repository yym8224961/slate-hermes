import { CreateDynamicContentRequest, type CreateDynamicContentRequestT } from 'shared';

export class CreateDynamicContentDto implements CreateDynamicContentRequestT {
  static readonly schema = CreateDynamicContentRequest;
  declare kind: 'dynamic';
  declare config: CreateDynamicContentRequestT['config'];
  declare frame_name?: string | null;
  declare initial_data?: CreateDynamicContentRequestT['initial_data'];
}
