import { CreateGroupRequest, type CreateGroupRequestT } from 'shared';

export class CreateGroupDto implements CreateGroupRequestT {
  static readonly schema = CreateGroupRequest;
  declare name: string;
}
