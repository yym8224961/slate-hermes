import { PreviewDynamicContentRequest, type PreviewDynamicContentRequestT } from 'shared';

export class PreviewDynamicContentDto implements PreviewDynamicContentRequestT {
  static readonly schema = PreviewDynamicContentRequest;
  declare config: PreviewDynamicContentRequestT['config'];
  declare frame_name?: string | null;
  declare data?: unknown;
}
