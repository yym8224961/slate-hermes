import { ReorderFramesRequest, type ReorderFramesRequestT } from 'shared';

export class ReorderFramesDto implements ReorderFramesRequestT {
  static readonly schema = ReorderFramesRequest;
  declare order: number[];
}
