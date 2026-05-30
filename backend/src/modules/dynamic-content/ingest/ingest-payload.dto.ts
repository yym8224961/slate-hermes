import { IngestPayload, type IngestPayloadT } from 'shared';

export class IngestPayloadDto implements IngestPayloadT {
  static readonly schema = IngestPayload;
  declare version: 1;
  declare data: IngestPayloadT['data'];
}
