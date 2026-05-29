import { Injectable } from '@nestjs/common';
import { clientIp } from '../../common/http/client-ip';
import { RateLimitGuardBase } from '../../common/rate-limit/rate-limit-guard';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const MAX_BUCKETS = 10_000;
const STALE_BUCKET_MS = WINDOW_MS * 2;

@Injectable()
export class DeviceRegisterRateLimitGuard extends RateLimitGuardBase {
  constructor() {
    super({
      limiter: {
        windowMs: WINDOW_MS,
        maxBuckets: MAX_BUCKETS,
        staleBucketMs: STALE_BUCKET_MS,
      },
      key: clientIp,
      maxPerWindow: MAX_PER_WINDOW,
      message: '设备注册过于频繁，请稍后重试',
    });
  }
}
