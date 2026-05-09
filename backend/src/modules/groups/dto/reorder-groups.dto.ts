import { ReorderGroupsRequest, type ReorderGroupsRequestT } from 'shared';

export class ReorderGroupsDto implements ReorderGroupsRequestT {
  static readonly schema = ReorderGroupsRequest;
  declare order: string[];
}
