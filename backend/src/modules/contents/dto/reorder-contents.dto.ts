import { ReorderContentsRequest, type ReorderContentsRequestT } from 'shared';

export class ReorderContentsDto implements ReorderContentsRequestT {
  static readonly schema = ReorderContentsRequest;
  declare order: string[];
}
