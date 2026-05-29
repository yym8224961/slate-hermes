import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientIp } from '../../common/http/client-ip';
import { RateLimitGuardBase } from '../../common/rate-limit/rate-limit-guard';

type AuthLimitKind = 'login' | 'register';

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const LIMITS: Record<AuthLimitKind, number> = {
  login: 10,
  register: 5,
};

@Injectable()
export class AuthRateLimitGuard extends RateLimitGuardBase {
  constructor() {
    super({
      limiter: {
        windowMs: WINDOW_MS,
        maxBuckets: MAX_BUCKETS,
      },
      key: (req) => {
        const kind = authLimitKind(req);
        return `${kind}:${clientIp(req)}`;
      },
      maxPerWindow: (req) => LIMITS[authLimitKind(req)],
      message: '请求过于频繁，请稍后重试',
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
