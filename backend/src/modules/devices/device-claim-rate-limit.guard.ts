import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CURRENT_USER_KEY,
  type WebUserContext,
} from '../../common/decorators/current-user.decorator';
import { clientIp } from '../../common/http/client-ip';
import { RateLimitGuardBase } from '../../common/rate-limit/rate-limit-guard';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const MAX_BUCKETS = 10_000;
const STALE_BUCKET_MS = WINDOW_MS * 2;

@Injectable()
export class DeviceClaimRateLimitGuard extends RateLimitGuardBase {
  constructor() {
    super({
      limiter: {
        windowMs: WINDOW_MS,
        maxBuckets: MAX_BUCKETS,
        staleBucketMs: STALE_BUCKET_MS,
      },
      key: (req) => {
        const userId = (req as FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext })[
          CURRENT_USER_KEY
        ]?.userId;
        return `${clientIp(req)}:${userId ?? 'anonymous'}`;
      },
      maxPerWindow: MAX_PER_WINDOW,
      message: '设备绑定尝试过于频繁，请稍后重试',
    });
  }
}
