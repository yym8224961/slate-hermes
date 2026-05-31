import type { FastifyRequest } from 'fastify';
import { CURRENT_USER_KEY, type WebUserContext } from '../../common/nest/auth-context';
import { clientIp } from '../../common/http/client-ip';
import { type RateLimitGuardOptions } from '../../common/rate-limit/rate-limit-guard';
import { createRateLimit } from '../../common/rate-limit/rate-limit-options';

export const deviceRegisterRateLimit: RateLimitGuardOptions = createRateLimit(
  {},
  {
    key: clientIp,
    maxPerWindow: 20,
    message: '设备注册过于频繁，请稍后重试',
  }
);

export const deviceClaimRateLimit: RateLimitGuardOptions = createRateLimit(
  {},
  {
    key: (req) => {
      const userId = (req as FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext })[
        CURRENT_USER_KEY
      ]?.userId;
      return `${clientIp(req)}:${userId ?? 'anonymous'}`;
    },
    maxPerWindow: 5,
    message: '设备绑定尝试过于频繁，请稍后重试',
  }
);
