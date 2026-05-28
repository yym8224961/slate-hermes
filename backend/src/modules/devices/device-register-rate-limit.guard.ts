import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '../../common/errors';
import { clientIp } from '../../common/http/client-ip';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const MAX_BUCKETS = 10_000;
const STALE_BUCKET_MS = WINDOW_MS * 2;

@Injectable()
export class DeviceRegisterRateLimitGuard implements CanActivate {
  /**
   * 单进程固定窗口限速，用来挡住随机 MAC 批量创建设备行。
   * 多实例部署时需要换成 Redis/网关限速，否则各实例之间不会共享计数。
   */
  private readonly limiter = new FixedWindowRateLimiter({
    windowMs: WINDOW_MS,
    maxBuckets: MAX_BUCKETS,
    staleBucketMs: STALE_BUCKET_MS,
  });

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const hit = this.limiter.hit(clientIp(req), MAX_PER_WINDOW);
    if (hit.allowed) return true;

    throw new RateLimitedError('设备注册过于频繁，请稍后重试', {
      retry_after_sec: hit.retryAfterSec,
    });
  }
}
