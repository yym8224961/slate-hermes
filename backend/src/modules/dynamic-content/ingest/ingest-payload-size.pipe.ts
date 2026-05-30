import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppError } from '../../../common/errors';

export const INGEST_MAX_BODY_BYTES = 64 * 1024;

export function assertIngestPayloadSize(body: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
  if (bytes > INGEST_MAX_BODY_BYTES) {
    throw ingestPayloadTooLarge();
  }
}

export function ingestPayloadTooLarge(): AppError {
  return new IngestPayloadTooLargeError('请求体超过 64KB', { code: 'payload_too_large' });
}

@Injectable()
export class IngestPayloadSizePipe implements PipeTransform {
  transform(value: unknown): unknown {
    assertIngestPayloadSize(value);
    return value;
  }
}

class IngestPayloadTooLargeError extends AppError {
  readonly code = 'payload_too_large';
  readonly httpStatus = 413;
}
