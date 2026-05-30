import { HttpException, HttpStatus, Injectable, type PipeTransform } from '@nestjs/common';

export const INGEST_MAX_BODY_BYTES = 64 * 1024;

export function assertIngestPayloadSize(body: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
  if (bytes > INGEST_MAX_BODY_BYTES) {
    throw ingestPayloadTooLarge();
  }
}

export function ingestPayloadTooLarge(): HttpException {
  return new HttpException(
    { error: 'payload_too_large', message: '请求体超过 64KB' },
    HttpStatus.PAYLOAD_TOO_LARGE
  );
}

@Injectable()
export class IngestPayloadSizePipe implements PipeTransform {
  transform(value: unknown): unknown {
    assertIngestPayloadSize(value);
    return value;
  }
}
