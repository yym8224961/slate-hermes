import { UpdateGroupRequest, type UpdateGroupRequestT } from 'shared';

export class UpdateGroupDto implements UpdateGroupRequestT {
  static readonly schema = UpdateGroupRequest;
  declare name?: string;
  declare sort_order?: number;
}
