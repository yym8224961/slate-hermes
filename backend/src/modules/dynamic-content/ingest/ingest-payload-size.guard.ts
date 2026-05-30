import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { INGEST_MAX_BODY_BYTES, ingestPayloadTooLarge } from './ingest-payload-size.pipe';

@Injectable()
export class IngestPayloadSizeGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const lenHeader = req.headers['content-length'];
    if (typeof lenHeader === 'string') {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > INGEST_MAX_BODY_BYTES) {
        throw ingestPayloadTooLarge();
      }
    }
    return true;
  }
}
