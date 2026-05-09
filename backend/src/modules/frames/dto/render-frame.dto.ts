import { RenderFrameRequest, type RenderFrameRequestT } from 'shared';

export class RenderFrameDto implements RenderFrameRequestT {
  static readonly schema = RenderFrameRequest;
  declare source: 'markdown' | 'html' | 'png_base64';
  declare content: string;
  declare threshold?: number;
  declare mode?: RenderFrameRequestT['mode'];
}
