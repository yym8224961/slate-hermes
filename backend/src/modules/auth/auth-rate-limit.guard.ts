import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '../../common/errors';
import { clientIp } from '../../common/http/client-ip';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter';

type AuthLimitKind = 'login' | 'register';

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const LIMITS: Record<AuthLimitKind, number> = {
  login: 10,
  register: 5,
};

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  /**
   * 单进程固定窗口限速，只作为当前单实例部署的本地保护。
   * 多实例部署时需要替换为 Redis/网关限速，否则各实例之间不会共享计数。
   */
  private readonly limiter = new FixedWindowRateLimiter({
    windowMs: WINDOW_MS,
    maxBuckets: MAX_BUCKETS,
  });

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const kind = authLimitKind(req);
    const key = `${kind}:${clientIp(req)}`;
    const hit = this.limiter.hit(key, LIMITS[kind]);

    if (hit.allowed) return true;

    throw new RateLimitedError('请求过于频繁，请稍后重试', {
      retry_after_sec: hit.retryAfterSec,
    });
  }
}

function authLimitKind(req: FastifyRequest): AuthLimitKind {
  if (req.method !== 'POST') return 'login';
  const routePath = normalizeAuthRoutePath(
    req.routeOptions?.url ?? req.routeOptions?.config?.url ?? req.url
  );
  if (routePath === '/users') return 'register';
  return 'login';
}

function normalizeAuthRoutePath(path: string | undefined): string {
  const raw = (path ?? '').split('?')[0] ?? '';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/^\/api\/v\d+(?=\/)/, '');
}
