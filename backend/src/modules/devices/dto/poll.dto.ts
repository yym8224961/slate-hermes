import { PollRequest, type PollRequestT } from 'shared';

export class PollDto implements PollRequestT {
  static readonly schema = PollRequest;
  declare telemetry?: PollRequestT['telemetry'];
}
