import { GenerateContentTtsRequest, type GenerateContentTtsRequestT } from 'shared';

export class GenerateContentTtsDto implements GenerateContentTtsRequestT {
  static readonly schema = GenerateContentTtsRequest;
  declare text: string;
  declare voice: GenerateContentTtsRequestT['voice'];
}
