import { RenderContentRequest, type RenderContentRequestT } from 'shared';

export class RenderContentDto implements RenderContentRequestT {
  static readonly schema = RenderContentRequest;
  declare source: 'markdown' | 'html' | 'png_base64';
  declare content: string;
  declare threshold?: number;
  declare mode?: RenderContentRequestT['mode'];
}
