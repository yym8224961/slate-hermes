import type { FastifyRequest } from 'fastify';
import { clientIp } from '../../common/http/client-ip';
import { type RateLimitGuardOptions } from '../../common/rate-limit/rate-limit-guard';
import { createRateLimit } from '../../common/rate-limit/rate-limit-options';

type AuthLimitKind = 'login' | 'register';

const LIMITS: Record<AuthLimitKind, number> = {
  login: 10,
  register: 5,
};

export const authRateLimit: RateLimitGuardOptions = createRateLimit(
  {},
  {
    key: (req) => {
      const kind = authLimitKind(req);
      return `${kind}:${clientIp(req)}`;
    },
    maxPerWindow: (req) => LIMITS[authLimitKind(req)],
    message: '请求过于频繁，请稍后重试',
  }
);

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
