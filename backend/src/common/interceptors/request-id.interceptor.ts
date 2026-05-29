import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestContext } from '../request-context';
import { safeRequestId } from '../request-id';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const headerId = req.headers['x-request-id'];
    const requestId = safeRequestId(headerId) ?? safeRequestId(req.id) ?? randomUUID();

    void reply.header('x-request-id', requestId);

    return new Observable((subscriber) => {
      requestContext.run({ requestId }, () => {
        const sub = next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
          complete: () => subscriber.complete(),
        });
        subscriber.add(sub);
      });
    });
  }
}
