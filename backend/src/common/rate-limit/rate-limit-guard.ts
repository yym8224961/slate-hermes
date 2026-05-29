import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '../errors';
import {
  FixedWindowRateLimiter,
  type FixedWindowRateLimiterOptions,
} from './fixed-window-rate-limiter';

export interface RateLimitGuardOptions {
  limiter: FixedWindowRateLimiterOptions;
  maxPerWindow: number | ((req: FastifyRequest) => number);
  key: (req: FastifyRequest) => string;
  message: string | ((req: FastifyRequest) => string);
}

export abstract class RateLimitGuardBase implements CanActivate {
  private readonly limiter: FixedWindowRateLimiter;

  protected constructor(private readonly opts: RateLimitGuardOptions) {
    this.limiter = new FixedWindowRateLimiter(opts.limiter);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const maxPerWindow =
      typeof this.opts.maxPerWindow === 'function'
        ? this.opts.maxPerWindow(req)
        : this.opts.maxPerWindow;
    const hit = this.limiter.hit(this.opts.key(req), maxPerWindow);
    if (hit.allowed) return true;

    throw new RateLimitedError(
      typeof this.opts.message === 'function' ? this.opts.message(req) : this.opts.message,
      { retry_after_sec: hit.retryAfterSec }
    );
  }
}
